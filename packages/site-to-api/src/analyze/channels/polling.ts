/**
 * Engine.IO long-polling (`/socket.io/?EIO=4&transport=polling`): Socket.IO's first transport,
 * and its only one where WebSockets are blocked. Each request is plain HTTP, but together they
 * are one connection: the handshake GET answers `0{"sid":…}`, later GETs carry server packets
 * and POSTs client packets, all with that `sid`. They become a connection like a socket's, so
 * the channel documents both transports (decision 0038).
 */
import type { Exchange } from '../../model'
import type { RawConnection, TimedFrame } from './connections'
import { pollingPackets } from './protocols'

function queryValue(exchange: Exchange, name: string): string | null {
  return exchange.request.query.find(param => param.name === name)?.value ?? null
}

/** Whether a request is Engine.IO long-polling: `transport=polling` with `EIO` or a `/socket.io/` path. */
export function isEnginePolling(exchange: Exchange): boolean {
  if (queryValue(exchange, 'transport') !== 'polling')
    return false
  return queryValue(exchange, 'EIO') !== null || /\/socket\.io\/?$/.test(exchange.request.path)
}

/** The session id an Engine.IO handshake response opens (`0{"sid":"…"}`), or null. */
function openedSid(exchange: Exchange): string | null {
  const body = exchange.response.body?.text
  if (body === undefined || body === null)
    return null
  for (const packet of pollingPackets(body, queryValue(exchange, 'EIO'))) {
    if (packet.binary || !packet.data.startsWith('0'))
      continue
    try {
      const open: unknown = JSON.parse(packet.data.slice(1))
      if (open !== null && typeof open === 'object' && 'sid' in open && typeof open.sid === 'string')
        return open.sid
    }
    catch {
      // Not an open packet after all; the request keeps no session.
    }
  }
  return null
}

function framesOf(exchange: Exchange): TimedFrame[] {
  const eio = queryValue(exchange, 'EIO')
  // A POST's packets are the client's; its response is only `ok`. A GET's response is the server's.
  const [direction, body] = exchange.request.method === 'POST'
    ? ['sent', exchange.request.body?.text] as const
    : ['received', exchange.response.body?.text] as const
  if (body === undefined || body === null || body === '')
    return []
  return pollingPackets(body, eio).map(packet => ({ direction, ts: exchange.startedAt, ...packet }))
}

/** A long-polling connection and the Engine.IO session id its requests share. */
export type PollingConnection = RawConnection & { sid: string }

/**
 * Sockets that upgrade an Engine.IO session (`?sid=` of a long-polling connection) take that
 * connection's frames before their own, in time order, and both transports: the session is one
 * connection, so its `connect` (with the auth payload, sent over polling) and its events (over
 * the socket) are seen together. The socket's upgrade request stays the one that counts.
 * Long-polling sessions that never upgraded are kept on their own, after the sockets.
 */
export function mergeUpgradedPolling(sockets: readonly RawConnection[], polling: readonly PollingConnection[]): RawConnection[] {
  const bySid = new Map(polling.map(connection => [connection.sid, connection]))
  const merged = new Set<string>()
  const result = sockets.map((socket) => {
    const sid = socket.query.find(param => param.name === 'sid')?.value
    const session = sid === undefined
      ? undefined
      : bySid.get(sid)
    if (session === undefined || merged.has(session.sid))
      return socket
    merged.add(session.sid)
    return {
      ...socket,
      openedAt: Math.min(session.openedAt, socket.openedAt),
      // Stable sort: polling frames come first at equal times, as they were sent first.
      frames: [
        ...session.frames,
        ...socket.frames,
      ].sort((a, b) => a.ts - b.ts),
      transports: ['polling', 'websocket'],
    } satisfies RawConnection
  })
  const rest = polling
    .filter(connection => !merged.has(connection.sid))
    .map(({ sid: _sid, ...connection }) => connection)
  return [
    ...result,
    ...rest,
  ]
}

function schemeOf(url: string): 'ws' | 'wss' {
  return url.startsWith('https:')
    ? 'wss'
    : 'ws'
}

/**
 * One connection per Engine.IO session of a capture session: its requests share a `sid` (the
 * handshake learns it from its response). Requests whose session never opened in the capture
 * still form one, from their `sid`.
 */
export function pollingConnections(sessionId: string, exchanges: readonly Exchange[]): PollingConnection[] {
  const requests = exchanges
    .filter(isEnginePolling)
    .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq)
  const bySid = new Map<string, PollingConnection>()
  const connections: PollingConnection[] = []
  for (const exchange of requests) {
    const sid = queryValue(exchange, 'sid') ?? openedSid(exchange)
    if (sid === null)
      continue
    let connection = bySid.get(sid)
    if (connection === undefined) {
      connection = {
        id: `${sessionId}:poll:${connections.length}`,
        sessionId,
        url: exchange.request.url,
        scheme: schemeOf(exchange.request.url),
        host: exchange.request.host,
        path: exchange.request.path,
        query: exchange.request.query,
        pageUrl: exchange.pageUrl ?? exchange.request.url,
        openedAt: exchange.startedAt,
        frames: [],
        transports: ['polling'],
        upgrade: exchange,
        sid,
      }
      bySid.set(sid, connection)
      connections.push(connection)
    }
    connection.frames.push(...framesOf(exchange))
  }
  return connections
}
