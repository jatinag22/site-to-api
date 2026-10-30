/**
 * WebSocket connections rebuilt from the `ws` capture events (and Engine.IO long-polling
 * requests), read with their framing protocol, and stand-in exchanges that let the redactor and
 * value tracing treat frames exactly like HTTP bodies (decisions 0023, 0038).
 */
import type { Body, ChannelProtocol, Exchange, LoadedSession, NameValue, WebSocketEvent } from '../../model'
import type { DecodedMessage, FrameRecord, Handshake, RawFrame } from './protocols'
import { decodeBinaryFrame } from './binary'
import { mergeUpgradedPolling, pollingConnections } from './polling'
import { decodeConnection } from './protocols'

/** One frame of a connection, in capture order (a frame that batches messages is one per message). */
export interface Frame {
  direction: 'sent' | 'received'
  ts: number
  data: string
  binary: boolean
  /**
   * The frame's content as JSON: a JSON text frame's object or array, a binary frame that
   * decoded as MessagePack or protobuf, or a protocol message's payload; `undefined` otherwise.
   */
  json: unknown
  /** How `json` was read; null when there is no `json`. */
  encoding: 'json' | 'msgpack' | 'protobuf' | null
  /** The framing protocol's reading of the frame; null when none was detected or it did not apply. */
  protocol: DecodedMessage | null
}

/** One socket opened during capture, or one Engine.IO long-polling session. */
export interface Connection {
  /** `<sessionId>:ws:<n>` (or `<sessionId>:poll:<n>` for long-polling), unique per build. */
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
  /**
   * How its frames travelled: `websocket`, `polling`, or both when an Engine.IO session started
   * on long-polling and upgraded (one connection, frames in time order).
   */
  transports: Array<'websocket' | 'polling'>
  /**
   * The HAR request that opened it: the upgrade request (status 101 when accepted), or the
   * Engine.IO handshake request for long-polling. Null when the HAR has none.
   */
  upgrade: Exchange | null
  /** The framing protocol its frames showed (decision 0038). */
  protocol: ChannelProtocol | null
}

/** A frame as the capture recorded it, before protocol decoding. */
export interface TimedFrame extends RawFrame {
  ts: number
}

/** A connection as captured, before protocol decoding. */
export type RawConnection = Omit<Connection, 'frames' | 'protocol' | 'upgrade'> & { frames: TimedFrame[], upgrade: Exchange | null }

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

function frameOf(event: WebSocketEvent): TimedFrame | null {
  if ((event.direction !== 'sent' && event.direction !== 'received') || event.data === null)
    return null
  return {
    direction: event.direction,
    ts: event.ts,
    data: event.data,
    binary: event.binary === true,
  }
}

/** Connections of one session as its events arrive; see {@link sessionConnections}. */
class ConnectionTracker {
  readonly connections: RawConnection[] = []
  private readonly bySocket = new Map<number, RawConnection>()
  private readonly openByUrl = new Map<string, RawConnection>()

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

  private connectionOf(event: WebSocketEvent): RawConnection | null {
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

  private start(event: WebSocketEvent): RawConnection | null {
    const parts = parseSocketUrl(event.url)
    if (parts === null)
      return null
    const connection: RawConnection = {
      id: `${this.sessionId}:ws:${this.connections.length}`,
      sessionId: this.sessionId,
      url: event.url,
      ...parts,
      pageUrl: event.pageUrl,
      openedAt: event.ts,
      frames: [],
      transports: ['websocket'],
      upgrade: null,
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
function sessionSockets(session: LoadedSession): RawConnection[] {
  const tracker = new ConnectionTracker(session.meta.sessionId)
  for (const event of session.events) {
    if (event.t === 'ws')
      tracker.add(event)
  }
  return tracker.connections
}

/** Upgrade requests further from the `open` event than this belong to another connection. */
const UPGRADE_MATCH_WINDOW_MS = 10_000

/** Sets each socket's HAR upgrade request: same session and URL, nearest in time, used once. */
function matchUpgrades(connections: readonly RawConnection[], exchanges: readonly Exchange[]): void {
  const upgrades = exchanges.filter(exchange => exchange.resourceType === 'websocket' || exchange.response.status === 101)
  const used = new Set<string>()
  for (const connection of connections) {
    let best: Exchange | null = null
    for (const exchange of upgrades) {
      if (used.has(exchange.id) || exchange.sessionId !== connection.sessionId || exchange.request.url !== connection.url)
        continue
      const distance = Math.abs(exchange.startedAt - connection.openedAt)
      if (distance > UPGRADE_MATCH_WINDOW_MS)
        continue
      if (best === null || distance < Math.abs(best.startedAt - connection.openedAt))
        best = exchange
    }
    if (best !== null) {
      used.add(best.id)
      connection.upgrade = best
    }
  }
}

/** `Sec-WebSocket-Protocol` values of a request or response, in order, once each. */
export function subprotocolsOf(headers: readonly NameValue[]): string[] {
  return [
    ...new Set(headers
      .filter(header => header.name.toLowerCase() === 'sec-websocket-protocol')
      .flatMap(header => header.value.split(','))
      .map(value => value.trim())
      .filter(Boolean)),
  ]
}

function handshakeOf(connection: RawConnection): Handshake {
  return {
    path: connection.path,
    query: connection.query,
    subprotocols: subprotocolsOf(connection.upgrade?.request.headers ?? []),
  }
}

/** A record as a frame: its JSON from the protocol payload, the JSON text or the binary readers. */
function frameOfRecord(source: TimedFrame, record: FrameRecord): Frame {
  const base = {
    direction: source.direction,
    ts: source.ts,
    data: record.data,
    binary: record.binary,
    protocol: record.decoded,
  }
  if (record.decoded !== null) {
    return record.decoded.payload === undefined
      ? { ...base, json: undefined, encoding: null }
      : { ...base, json: record.decoded.payload, encoding: 'json' }
  }
  if (record.binary) {
    const decoded = decodeBinaryFrame(record.data)
    return decoded === null
      ? { ...base, json: undefined, encoding: null }
      : { ...base, json: decoded.value, encoding: decoded.encoding }
  }
  const json = parseFrameJson(record.data)
  return {
    ...base,
    json,
    encoding: json === undefined
      ? null
      : 'json',
  }
}

/** Reads a captured connection with its framing protocol and binary decoders. */
function decoded(connection: RawConnection): Connection {
  const reading = decodeConnection(connection.frames, handshakeOf(connection))
  return {
    ...connection,
    protocol: reading.protocol,
    frames: connection.frames.flatMap((frame, index) => (reading.frames[index] ?? []).map(record => frameOfRecord(frame, record))),
  }
}

/**
 * Every connection of every session, ordered by session id, then sockets in opening order, then
 * Engine.IO long-polling sessions that never upgraded (one that did is part of its socket). `exchanges` (the HAR) gives each socket its upgrade request,
 * which names the subprotocol, and holds the long-polling requests.
 */
export function collectConnections(sessions: readonly LoadedSession[], exchanges: readonly Exchange[] = []): Connection[] {
  return [...sessions]
    .sort((a, b) => a.meta.sessionId.localeCompare(b.meta.sessionId))
    .flatMap((session) => {
      const sockets = sessionSockets(session)
      matchUpgrades(sockets, exchanges)
      const sessionId = session.meta.sessionId
      const polling = pollingConnections(sessionId, exchanges.filter(exchange => exchange.sessionId === sessionId))
      return mergeUpgradedPolling(sockets, polling).map(decoded)
    })
}

/**
 * Values the connections' protocols say are credentials (decision 0047), for the redactor:
 * sorted, once each.
 */
export function protocolSecrets(connections: readonly Connection[]): string[] {
  const values = new Set<string>()
  for (const connection of connections) {
    for (const frame of connection.frames) {
      for (const value of frame.protocol?.secrets ?? [])
        values.add(value)
    }
  }
  return [...values].sort()
}

function frameBody(frame: Frame): Body {
  if (frame.json !== undefined) {
    // Decoded binary and protocol payloads are bodies the redactor and tracing can read.
    return {
      mimeType: 'application/json',
      text: frame.binary
        ? null
        : frame.data,
      base64: frame.binary
        ? frame.data
        : null,
      json: frame.json,
      form: null,
    }
  }
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
    mimeType: 'text/plain',
    text: frame.data,
    base64: null,
    json: undefined,
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
      const kind = sent && (!frame.binary || frame.json !== undefined) && traced < MAX_TRACED_FRAMES
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
