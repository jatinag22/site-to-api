/**
 * How the connections to a channel were opened (decision 0038): the `Origin` the browser sent,
 * the subprotocol asked for and picked, tokens in the URL (names only), whether the server
 * accepted the upgrade, and the first message that opened or authenticated the connection with
 * the server's answer. Facts from the capture only, every value through the redactor.
 */
import type { ChannelConnectionFacts, ChannelMessage, Redactor } from '../../model'
import type { Connection } from './connections'
import { isRandomPathSegment, isSecretName, isSecretPathSegment } from '../redact'
import { subprotocolsOf } from './connections'
import { roleOf } from './handshake'

function headerValues(connections: readonly Connection[], name: string, side: 'request' | 'response'): string[] {
  return connections.flatMap(connection => (connection.upgrade?.[side].headers ?? [])
    .filter(header => header.name.toLowerCase() === name)
    .map(header => header.value))
}

function sorted(values: Iterable<string>): string[] {
  return [
    ...new Set(values),
  ].sort()
}

/**
 * A subprotocol as written: redacted, and with any part that looks like a token replaced, since
 * some sites send a bearer token as a subprotocol (`base64url.bearer.authorization.k8s.io.<token>`).
 */
function safeSubprotocol(value: string, redactor: Redactor): string {
  const redacted = redactor.value(value, { in: 'header', name: 'sec-websocket-protocol' })
  return redacted
    .split('.')
    .map(part => isSecretPathSegment(part) || isRandomPathSegment(part)
      ? '<token>'
      : part)
    .join('.')
}

/** Query parameter names whose values are secrets: secret-named, or changed by the redactor. */
function urlTokens(connections: readonly Connection[], redactor: Redactor): string[] {
  const names = new Set<string>()
  for (const connection of connections) {
    for (const { name, value } of connection.query) {
      if (isSecretName(name, true) || redactor.value(value, { in: 'query', name }) !== value)
        names.add(redactor.value(name, { in: 'text' }))
    }
  }
  return sorted(names)
}

function upgradeOf(connections: readonly Connection[]): ChannelConnectionFacts['upgrade'] {
  const result = {
    accepted: 0,
    rejected: 0,
    unknown: 0,
    statuses: new Set<number>(),
  }
  for (const connection of connections) {
    const status = connection.upgrade?.response.status
    const answered = connection.frames.some(frame => frame.direction === 'received')
    if (status !== undefined && status > 0)
      result.statuses.add(status)
    // Long-polling and event streams answer with plain HTTP; only a WebSocket switches protocols.
    const http = connection.transports.length === 1 && (connection.transports[0] === 'polling' || connection.transports[0] === 'sse')
    const ok = http
      ? status !== undefined && status >= 200 && status < 300
      : status === 101
    if (ok || answered)
      result.accepted++
    else if (status !== undefined && status > 0)
      result.rejected++
    else
      result.unknown++
  }
  return {
    accepted: result.accepted,
    rejected: result.rejected,
    unknown: result.unknown,
    statuses: [...result.statuses].sort((a, b) => a - b),
  }
}

/**
 * The first client message whose role is `init` or `auth`, and the next server message after
 * it, per connection; the most common pair, an `auth` one first (ties: the first connection that
 * showed it).
 */
function firstMessageOf(connections: readonly Connection[], messages: readonly ChannelMessage[], messageOf: ReadonlyMap<string, string>): ChannelConnectionFacts['firstMessage'] {
  const byId = new Map(messages.map(message => [message.id, message]))
  const counts = new Map<string, { count: number, value: NonNullable<ChannelConnectionFacts['firstMessage']> }>()
  for (const connection of connections) {
    const index = connection.frames.findIndex((frame, at) => {
      const message = frame.direction === 'sent'
        ? byId.get(messageOf.get(`${connection.id}:${at}`) ?? '')
        : undefined
      const role = message === undefined
        ? null
        : roleOf(message)
      return role === 'init' || role === 'auth'
    })
    const message = index === -1
      ? undefined
      : byId.get(messageOf.get(`${connection.id}:${index}`) ?? '')
    if (message === undefined)
      continue
    const replyIndex = connection.frames.findIndex((frame, at) => at > index && frame.direction === 'received')
    const reply = replyIndex === -1
      ? null
      : messageOf.get(`${connection.id}:${replyIndex}`) ?? null
    const role = roleOf(message) === 'auth'
      ? 'auth'
      : 'init'
    const key = `${message.id}\u0000${reply ?? ''}`
    const entry = counts.get(key)
    if (entry) {
      entry.count++
    }
    else {
      counts.set(key, {
        count: 1,
        value: { message: message.id, role, reply },
      })
    }
  }
  let best: { count: number, value: NonNullable<ChannelConnectionFacts['firstMessage']> } | null = null
  // An authentication message says more about how the connection is opened than a bare start
  // (`5` after an Engine.IO upgrade), so it wins over a more common `init`.
  const weight = (entry: { count: number, value: { role: string } }): number => (entry.value.role === 'auth'
    ? 1_000_000
    : 0) + entry.count
  for (const entry of counts.values()) {
    if (best === null || weight(entry) > weight(best))
      best = entry
  }
  return best?.value ?? null
}

/** Input of {@link connectionFacts}. */
export interface FactsInput {
  connections: readonly Connection[]
  /** Every message of the channel, both directions. */
  messages: readonly ChannelMessage[]
  /** Message id per `<connection id>:<frame index>`, both directions. */
  messageOf: ReadonlyMap<string, string>
  redactor: Redactor
}

/** The connection facts of one channel. */
export function connectionFacts(input: FactsInput): ChannelConnectionFacts {
  const { connections, redactor } = input
  return {
    origins: sorted(headerValues(connections, 'origin', 'request').map(value => redactor.value(value, { in: 'header', name: 'origin' }))),
    subprotocols: {
      requested: sorted(connections.flatMap(connection => subprotocolsOf(connection.upgrade?.request.headers ?? [])).map(value => safeSubprotocol(value, redactor))),
      selected: sorted(headerValues(connections, 'sec-websocket-protocol', 'response').map(value => safeSubprotocol(value.trim(), redactor))),
    },
    urlTokens: urlTokens(connections, redactor),
    upgrade: upgradeOf(connections),
    firstMessage: firstMessageOf(connections, input.messages, input.messageOf),
    transports: sorted(connections.flatMap(connection => connection.transports)).filter(value => value === 'websocket' || value === 'polling' || value === 'sse'),
  }
}
