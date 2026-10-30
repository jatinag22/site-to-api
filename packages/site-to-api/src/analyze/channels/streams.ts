/**
 * Server-sent event streams as channel connections (decision 0049). A stream's events come from
 * the capture's `sse` events (Chrome reports each event an `EventSource` receives, also on a
 * stream that never ends) or, for a stream that ended during the capture (`fetch` reading
 * `text/event-stream`), from the response body the HAR holds. Each event is a received frame.
 */
import type { Exchange, LoadedSession, ServerSentEvent } from '../../model'
import type { RawConnection } from './connections'
import { eventWire, parseEventStream } from './protocols'

/** A stream request further from its first event than this belongs to another stream. */
const STREAM_MATCH_WINDOW_MS = 30_000

function streamUrlParts(url: string): Pick<RawConnection, 'scheme' | 'host' | 'path' | 'query'> | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return null
  return {
    scheme: parsed.protocol === 'https:'
      ? 'https'
      : 'http',
    host: parsed.host,
    path: parsed.pathname || '/',
    query: [...parsed.searchParams].map(([name, value]) => ({ name, value })),
  }
}

function isEventStreamExchange(exchange: Exchange): boolean {
  return exchange.response.body?.mimeType === 'text/event-stream' || exchange.resourceType === 'eventsource'
}

/** The HAR request that opened a stream: same URL, nearest before (or at) its first event, used once. */
function streamRequest(url: string, openedAt: number, candidates: readonly Exchange[], used: Set<string>): Exchange | null {
  let best: Exchange | null = null
  for (const exchange of candidates) {
    if (used.has(exchange.id) || exchange.request.url !== url)
      continue
    const distance = Math.abs(openedAt - exchange.startedAt)
    if (distance > STREAM_MATCH_WINDOW_MS)
      continue
    if (best === null || distance < Math.abs(openedAt - best.startedAt))
      best = exchange
  }
  if (best !== null)
    used.add(best.id)
  return best
}

function connectionOf(sessionId: string, index: number, url: string, pageUrl: string, openedAt: number, request: Exchange | null): RawConnection | null {
  const parts = streamUrlParts(url)
  if (parts === null)
    return null
  return {
    id: `${sessionId}:sse:${index}`,
    sessionId,
    url,
    ...parts,
    pageUrl,
    openedAt,
    frames: [],
    transports: ['sse'],
    upgrade: request,
  }
}

/** One session's `sse` events, grouped by stream number in opening order. */
function eventsByStream(session: LoadedSession): ServerSentEvent[][] {
  const streams = new Map<number, ServerSentEvent[]>()
  for (const event of session.events) {
    if (event.t !== 'sse')
      continue
    const list = streams.get(event.stream) ?? []
    list.push(event)
    streams.set(event.stream, list)
  }
  return [...streams].sort(([a], [b]) => a - b).map(([, list]) => list)
}

/**
 * The event-stream connections of one session: those Chrome reported event by event, then
 * streams the HAR holds a body for that no reported stream matched. `exchanges` are the
 * session's HAR exchanges; the request a stream was opened with becomes its `upgrade`.
 */
export function eventStreamConnections(session: LoadedSession, exchanges: readonly Exchange[]): RawConnection[] {
  const sessionId = session.meta.sessionId
  const candidates = exchanges.filter(exchange => exchange.sessionId === sessionId && isEventStreamExchange(exchange))
  const used = new Set<string>()
  const connections: RawConnection[] = []
  for (const events of eventsByStream(session)) {
    const [first] = events
    if (first === undefined)
      continue
    const connection = connectionOf(sessionId, connections.length, first.url, first.pageUrl, first.ts, streamRequest(first.url, first.ts, candidates, used))
    if (connection === null)
      continue
    connection.frames = events.map(event => ({
      direction: 'received',
      ts: event.ts,
      data: eventWire(event),
      binary: false,
    }))
    connections.push(connection)
  }
  for (const exchange of candidates) {
    const text = exchange.response.body?.text ?? ''
    if (used.has(exchange.id) || text === '')
      continue
    const events = parseEventStream(text)
    if (events.length === 0)
      continue
    const connection = connectionOf(sessionId, connections.length, exchange.request.url, exchange.pageUrl ?? exchange.request.url, exchange.startedAt, exchange)
    if (connection === null)
      continue
    used.add(exchange.id)
    connection.frames = events.map(event => ({
      direction: 'received',
      ts: exchange.startedAt,
      data: eventWire(event),
      binary: false,
    }))
    connections.push(connection)
  }
  return connections
}
