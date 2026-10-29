/**
 * What a client sends to set up a connection: authentication and subscriptions, told apart from
 * data, keep-alives and teardown by the message type's name (decision 0030).
 */
import type { ChannelMessage, HandshakeRole, Redactor, WebSocketChannel } from '../../model'
import type { Connection } from './connections'

/** Role of a client message type, from the words of its name. */
export type MessageRole = Exclude<HandshakeRole, 'other'> | 'unsubscribe' | 'keepalive' | 'data'

/** Client frames after the connection opens that can still be part of the setup. */
const MAX_SETUP_SCAN = 10
/** Longest setup sequence reported. */
const MAX_HANDSHAKE_MESSAGES = 5

// Checked in this order: `unsubscribe` holds `subscribe`, `authTick` is still auth.
const ROLE_WORDS: ReadonlyArray<[MessageRole, ReadonlySet<string>]> = [
  [
    'unsubscribe',
    new Set([
      'unsubscribe',
      'unsub',
      'leave',
      'part',
      'unlisten',
      'unwatch',
      'untrack',
      'close',
      'disconnect',
      'logout',
      'signout',
      'bye',
      'complete',
      'stop',
    ]),
  ],
  [
    'keepalive',
    new Set([
      'ping',
      'pong',
      'heartbeat',
      'keepalive',
      'hb',
    ]),
  ],
  [
    'auth',
    new Set([
      'auth',
      'authenticate',
      'authentication',
      'authorize',
      'authorization',
      'login',
      'signin',
      'identify',
      'token',
    ]),
  ],
  [
    'subscribe',
    new Set([
      'subscribe',
      'sub',
      'subscription',
      'join',
      'listen',
      'watch',
      'track',
      'start',
    ]),
  ],
  [
    'init',
    new Set([
      'init',
      'hello',
      'connect',
      'connection',
      'handshake',
      'welcome',
    ]),
  ],
]

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
}

/**
 * The role a message type's name gives it: `auth` (`auth`, `login`, `identify`), `subscribe`
 * (`subscribe`, `SUBSCRIBE`, `join`), `init` (`connection_init`, `hello`), `unsubscribe`
 * (`unsubscribe`, `leave`), `keepalive` (`ping`, `heartbeat`); anything else is `data`.
 */
export function messageRole(name: string): MessageRole {
  const words = nameWords(name)
  for (const [role, set] of ROLE_WORDS) {
    if (words.some(word => set.has(word)))
      return role
  }
  return 'data'
}

function isSetupRole(role: MessageRole): role is Exclude<HandshakeRole, 'other'> {
  return role === 'init' || role === 'auth' || role === 'subscribe'
}

interface Opening {
  indexes: number[]
  roles: HandshakeRole[]
}

/**
 * The setup messages of one connection: among its first client frames, those whose type is an
 * init, auth or subscribe message, in order, up to the first teardown. When none is recognised,
 * the first client frame, as `other`: the site may use names this does not know.
 */
function openingOf(connection: Connection, connectionMessages: ReadonlyMap<number, ChannelMessage>): Opening {
  const sent = connection.frames.flatMap((frame, index) => frame.direction === 'sent'
    ? [index]
    : []).slice(0, MAX_SETUP_SCAN)
  const indexes: number[] = []
  const roles: HandshakeRole[] = []
  for (const index of sent) {
    const message = connectionMessages.get(index)
    const role = message
      ? messageRole(message.discriminator?.value ?? '')
      : 'data'
    if (role === 'unsubscribe')
      break
    if (isSetupRole(role) && indexes.length < MAX_HANDSHAKE_MESSAGES) {
      indexes.push(index)
      roles.push(role)
    }
  }
  if (indexes.length === 0 && sent[0] !== undefined) {
    return {
      indexes: [sent[0]],
      roles: ['other'],
    }
  }
  return { indexes, roles }
}

/**
 * The messages to send after connecting: the most common setup sequence across connections (ties:
 * the first connection that showed it), each with its role and a redacted example.
 *
 * @param connections the channel's connections
 * @param messages the channel's client messages, to read each type's name
 * @param messageOf message id per `<connection id>:<frame index>`
 * @param redactor applied to the examples
 */
export function handshakeOf(connections: readonly Connection[], messages: readonly ChannelMessage[], messageOf: ReadonlyMap<string, string>, redactor: Redactor): WebSocketChannel['handshake'] {
  const byId = new Map(messages.map(message => [message.id, message]))
  const sequences = new Map<string, { count: number, connection: Connection, opening: Opening }>()
  for (const connection of connections) {
    const connectionMessages = new Map<number, ChannelMessage>()
    connection.frames.forEach((_, index) => {
      const message = byId.get(messageOf.get(`${connection.id}:${index}`) ?? '')
      if (message)
        connectionMessages.set(index, message)
    })
    const opening = openingOf(connection, connectionMessages)
    if (opening.indexes.length === 0)
      continue
    const key = opening.indexes.map(index => messageOf.get(`${connection.id}:${index}`) ?? '').join('\u0000')
    const entry = sequences.get(key)
    if (entry)
      entry.count++
    else
      sequences.set(key, { count: 1, connection, opening })
  }
  let best: { count: number, connection: Connection, opening: Opening } | null = null
  for (const entry of sequences.values()) {
    if (best === null || entry.count > best.count)
      best = entry
  }
  if (best === null)
    return []
  const { connection, opening } = best
  return opening.indexes.map((index, position) => {
    const frame = connection.frames[index]
    const example = frame === undefined || frame.binary
      ? undefined
      : redactor.examples([frame.json ?? frame.data], { in: 'body' })[0]
    return {
      message: messageOf.get(`${connection.id}:${index}`) ?? '',
      role: opening.roles[position] ?? 'other',
      example: example ?? null,
    }
  })
}
