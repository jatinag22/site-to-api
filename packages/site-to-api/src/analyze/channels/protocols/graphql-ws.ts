/**
 * GraphQL over WebSocket (decision 0038): `graphql-transport-ws` (the `graphql-ws` library:
 * `connection_init`, `subscribe`, `next`, `complete`, `ping`/`pong`) and the older
 * `subscriptions-transport-ws` (`start`, `data`, `stop`, `ka`, `connection_terminate`). A
 * subscription is named like the GraphQL operations of `analyze/graphql` (its `operationName`,
 * the name in its document, or `document-<hash>`), and its results carry the same name through
 * their `id`.
 */
import type { DecodedMessage, DecoderSession, Handshake, ProtocolDecoder, RawFrame } from './types'
import { graphqlOperationLabel } from '../../graphql'
import { isRecord, message, parseJson } from './types'

const MODERN_ONLY = new Set(['subscribe', 'next', 'ping', 'pong'])
const LEGACY_ONLY = new Set([
  'start',
  'data',
  'stop',
  'ka',
  'connection_terminate',
  'connection_keep_alive',
])
const SHARED = new Set([
  'connection_init',
  'connection_ack',
  'connection_error',
  'error',
  'complete',
])
const STARTS = new Set(['subscribe', 'start'])
const RESULTS = new Set(['next', 'data', 'error'])

const ROLES: Record<string, DecodedMessage['role']> = {
  connection_init: 'init',
  subscribe: 'subscribe',
  start: 'subscribe',
  complete: 'unsubscribe',
  stop: 'unsubscribe',
  connection_terminate: 'unsubscribe',
  ping: 'keepalive',
  pong: 'keepalive',
  ka: 'keepalive',
  connection_keep_alive: 'keepalive',
}

class GraphqlWsSession implements DecoderSession {
  private readonly operations = new Map<string, string>()
  private modern = false
  private legacy = false

  read(frame: RawFrame): DecodedMessage[] | null {
    if (frame.binary)
      return null
    const json = parseJson(frame.data)
    if (!isRecord(json) || typeof json.type !== 'string')
      return null
    const { type } = json
    if (!SHARED.has(type) && !MODERN_ONLY.has(type) && !LEGACY_ONLY.has(type))
      return null
    this.modern ||= MODERN_ONLY.has(type)
    this.legacy ||= LEGACY_ONLY.has(type)
    const id = typeof json.id === 'string' || typeof json.id === 'number'
      ? String(json.id)
      : null
    const name = this.nameOf(type, id, json.payload)
    if (name === null)
      return null
    const hasPayload = json.payload !== undefined && json.payload !== null
    const role = type === 'connection_init' && isRecord(json.payload) && Object.keys(json.payload).length > 0
      ? 'auth'
      : ROLES[type] ?? 'data'
    const strong = STARTS.has(type) || type === 'connection_init' || type === 'connection_ack'
    return [
      message({
        data: frame.data,
        frame: type,
        name: [name],
        role,
        wire: `{${id === null
          ? ''
          : '"id":"<id>",'}"type":"${type}"${hasPayload
          ? ',"payload":<payload>'
          : ''}}`,
        payload: hasPayload
          ? json.payload
          : undefined,
        strong,
      }),
    ]
  }

  /**
   * A subscription's GraphQL operation (null when its payload is not GraphQL), a result's
   * operation through its id, otherwise the message type.
   */
  private nameOf(type: string, id: string | null, payload: unknown): string | null {
    if (STARTS.has(type)) {
      const label = isRecord(payload)
        ? graphqlOperationLabel(payload)
        : null
      if (label !== null && id !== null)
        this.operations.set(id, label)
      return label
    }
    return RESULTS.has(type) && id !== null
      ? this.operations.get(id) ?? type
      : type
  }

  version(): string | null {
    if (this.modern === this.legacy)
      return null
    return this.modern
      ? 'graphql-transport-ws'
      : 'subscriptions-transport-ws'
  }
}

/** `graphql-transport-ws` is the current protocol; the subprotocol `graphql-ws` is the old one. */
function subprotocolOf(handshake: Handshake): string | null {
  return handshake.subprotocols.find(value => value === 'graphql-transport-ws' || value === 'graphql-ws') ?? null
}

export const graphqlWs: ProtocolDecoder = {
  id: 'graphql-ws',
  hint: (handshake) => {
    const subprotocol = subprotocolOf(handshake)
    return subprotocol === null
      ? null
      : `subprotocol ${subprotocol}`
  },
  handshakeVersion: (handshake) => {
    const subprotocol = subprotocolOf(handshake)
    if (subprotocol === null)
      return null
    return subprotocol === 'graphql-transport-ws'
      ? 'graphql-transport-ws'
      : 'subscriptions-transport-ws'
  },
  start: () => new GraphqlWsSession(),
}
