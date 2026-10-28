/**
 * WebSocket connections rebuilt from the `ws` capture events, and stand-in exchanges that let the
 * redactor and value tracing treat frames exactly like HTTP bodies (decision 0023).
 */
import type { Body, Exchange, LoadedSession, NameValue, WebSocketEvent } from '../../model'

/** One frame of a connection, in capture order. */
export interface Frame {
  direction: 'sent' | 'received'
  ts: number
  data: string
  binary: boolean
  /** Parsed JSON for text frames holding an object or array; `undefined` otherwise. */
  json: unknown
}

/** One socket opened during capture. */
export interface Connection {
  /** `<sessionId>:ws:<n>`, unique per build. */
  id: string
  sessionId: string
  url: string
  scheme: 'ws' | 'wss'
  host: string
  path: string
  query: NameValue[]
  pageUrl: string
  openedAt: number
  frames: Frame[]
}

/**
 * Client frames per connection that value tracing looks at. The opening messages carry the ids
 * worth linking; a socket that sends a heartbeat every second would otherwise cost one trace per
 * frame for nothing.
 */
const MAX_TRACED_FRAMES = 20

/** JSON objects and arrays only: a frame `"42"` or `ping` is text, not a structured message. */
export function parseFrameJson(data: string): unknown {
  const trimmed = data.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
    return undefined
  try {
    return JSON.parse(trimmed) as unknown
  }
  catch {
    return undefined
  }
}

function parseSocketUrl(url: string): Pick<Connection, 'scheme' | 'host' | 'path' | 'query'> | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    return null
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
    return null
  return {
    scheme: parsed.protocol === 'wss:'
      ? 'wss'
      : 'ws',
    host: parsed.host,
    path: parsed.pathname || '/',
    query: [...parsed.searchParams].map(([name, value]) => ({ name, value })),
  }
}

function frameOf(event: WebSocketEvent): Frame | null {
  if ((event.direction !== 'sent' && event.direction !== 'received') || event.data === null)
    return null
  const binary = event.binary === true
  return {
    direction: event.direction,
    ts: event.ts,
    data: event.data,
    binary,
    json: binary
      ? undefined
      : parseFrameJson(event.data),
  }
}

/** Connections of one session as its events arrive; see {@link sessionConnections}. */
class ConnectionTracker {
  readonly connections: Connection[] = []
  private readonly bySocket = new Map<number, Connection>()
  private readonly openByUrl = new Map<string, Connection>()

  constructor(private readonly sessionId: string) {}

  add(event: WebSocketEvent): void {
    const connection = this.connectionOf(event)
    if (connection === null)
      return
    if (event.socket !== undefined)
      this.bySocket.set(event.socket, connection)
    if (event.direction === 'close') {
      if (this.openByUrl.get(event.url) === connection)
        this.openByUrl.delete(event.url)
      return
    }
    this.openByUrl.set(event.url, connection)
    const frame = frameOf(event)
    if (frame !== null)
      connection.frames.push(frame)
  }

  private connectionOf(event: WebSocketEvent): Connection | null {
    const known = event.socket === undefined
      ? this.openByUrl.get(event.url)
      : this.bySocket.get(event.socket)
    // Without socket numbers every `open` is a new socket; with them, only an unseen number is.
    if (event.direction === 'open' && (event.socket === undefined || known === undefined))
      return this.start(event)
    if (known !== undefined)
      return known
    // A frame without its `open` (recording started late) still counts; a lone `close` does not.
    return event.direction === 'close'
      ? null
      : this.start(event)
  }

  private start(event: WebSocketEvent): Connection | null {
    const parts = parseSocketUrl(event.url)
    if (parts === null)
      return null
    const connection: Connection = {
      id: `${this.sessionId}:ws:${this.connections.length}`,
      sessionId: this.sessionId,
      url: event.url,
      ...parts,
      pageUrl: event.pageUrl,
      openedAt: event.ts,
      frames: [],
    }
    this.connections.push(connection)
    return connection
  }
}

/**
 * Splits one session's `ws` events into connections. Events that carry a socket number are
 * grouped by it; older captures only have the URL, so a frame joins the latest connection to
 * that URL that is still open (two sockets to one URL at the same time are merged there).
 */
function sessionConnections(session: LoadedSession): Connection[] {
  const tracker = new ConnectionTracker(session.meta.sessionId)
  for (const event of session.events) {
    if (event.t === 'ws')
      tracker.add(event)
  }
  return tracker.connections
}

/** Every connection of every session, ordered by session id, then opening time. */
export function collectConnections(sessions: readonly LoadedSession[]): Connection[] {
  return [...sessions]
    .sort((a, b) => a.meta.sessionId.localeCompare(b.meta.sessionId))
    .flatMap(sessionConnections)
}

function frameBody(frame: Frame): Body {
  if (frame.binary) {
    return {
      mimeType: 'application/octet-stream',
      text: null,
      base64: frame.data,
      json: undefined,
      form: null,
    }
  }
  return {
    mimeType: frame.json === undefined
      ? 'text/plain'
      : 'application/json',
    text: frame.data,
    base64: null,
    json: frame.json,
    form: null,
  }
}

/** What a stand-in exchange represents: the connection URL, or one frame of it. */
export interface StandIn {
  connection: Connection
  /** Index into `connection.frames`, or null for the connection URL itself. */
  frame: number | null
}

/** Stand-in exchanges and what each one stands for. */
export interface ChannelExchanges {
  exchanges: Exchange[]
  standIns: Map<string, StandIn>
}

function standInExchange(connection: Connection, id: string, seq: number, startedAt: number, kind: Exchange['kind'], parts: { query: NameValue[], requestBody: Body | null, responseBody: Body | null }): Exchange {
  return {
    id,
    sessionId: connection.sessionId,
    seq,
    startedAt,
    resourceType: 'websocket',
    pageUrl: connection.pageUrl,
    request: {
      method: 'GET',
      url: connection.url,
      host: connection.host,
      path: connection.path,
      query: parts.query,
      headers: [],
      cookies: [],
      body: parts.requestBody,
    },
    response: {
      status: 101,
      statusText: 'Switching Protocols',
      headers: [],
      setCookies: [],
      body: parts.responseBody,
    },
    initiator: null,
    kind,
    kindReason: 'websocket frame',
  }
}

/**
 * Exchanges standing in for connections and frames, for the stages that already know how to
 * handle HTTP: the redactor learns secrets from them (a token sent in a frame is scrubbed wherever
 * it is echoed), and value tracing finds where the connection URL's values and the client's first
 * frames came from. Client frames become request bodies, server frames response bodies.
 *
 * Only the connection URL and the first client frames are `api` (traced); server frames and later
 * client frames are `noise`, so tracing skips them and they never become producers of HTTP inputs.
 * Ids start with the connection id, which no HAR exchange id can (`<sessionId>:<index>`).
 */
export function channelExchanges(connections: readonly Connection[]): ChannelExchanges {
  const exchanges: Exchange[] = []
  const standIns = new Map<string, StandIn>()
  connections.forEach((connection, connectionIndex) => {
    // Sequence numbers after every HAR entry of the session, in frame order.
    const base = 1_000_000 * (connectionIndex + 1)
    const urlId = `${connection.id}:url`
    exchanges.push(standInExchange(connection, urlId, base, connection.openedAt, 'api', {
      query: connection.query,
      requestBody: null,
      responseBody: null,
    }))
    standIns.set(urlId, { connection, frame: null })
    let traced = 0
    connection.frames.forEach((frame, index) => {
      const id = `${connection.id}:${index}`
      const sent = frame.direction === 'sent'
      const kind = sent && !frame.binary && traced < MAX_TRACED_FRAMES
        ? 'api'
        : 'noise'
      if (kind === 'api')
        traced++
      exchanges.push(standInExchange(connection, id, base + index + 1, frame.ts, kind, {
        query: [],
        requestBody: sent
          ? frameBody(frame)
          : null,
        responseBody: sent
          ? null
          : frameBody(frame),
      }))
      standIns.set(id, { connection, frame: index })
    })
  })
  return { exchanges, standIns }
}
