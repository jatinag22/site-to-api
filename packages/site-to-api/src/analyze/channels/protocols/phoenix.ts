/**
 * Phoenix channels (decision 0038). Serializer 2.0 sends arrays
 * `[join_ref, ref, topic, event, payload]`; 1.0 sends objects `{topic, event, payload, ref}`.
 * The message name is `topic:event` (`room:{id}:phx_join`). `phx_join` subscribes, `phx_leave`
 * leaves, `heartbeat` on the `phoenix` topic keeps the socket alive, `phx_reply` answers a push.
 */
import type { DecodedMessage, DecoderSession, Handshake, ProtocolDecoder, RawFrame } from './types'
import { isRecord, message, parseJson } from './types'

const ROLES: Record<string, DecodedMessage['role']> = {
  phx_join: 'subscribe',
  phx_leave: 'unsubscribe',
  phx_close: 'unsubscribe',
  heartbeat: 'keepalive',
  phx_reply: 'data',
  phx_error: 'data',
}

interface PhoenixMessage {
  topic: string
  event: string
  payload: unknown
  form: 'array' | 'object'
}

function isRef(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function readMessage(json: unknown): PhoenixMessage | null {
  if (Array.isArray(json)) {
    const [joinRef, ref, topic, event, payload] = json
    return json.length === 5 && isRef(joinRef) && isRef(ref) && typeof topic === 'string' && topic !== '' && typeof event === 'string' && event !== ''
      ? { topic, event, payload, form: 'array' }
      : null
  }
  if (!isRecord(json) || typeof json.topic !== 'string' || typeof json.event !== 'string' || !('payload' in json) || !('ref' in json) || !isRef(json.ref))
    return null
  return {
    topic: json.topic,
    event: json.event,
    payload: json.payload,
    form: 'object',
  }
}

/** Phoenix's own events; any other event is a push from the application. */
const PHOENIX_EVENTS = new Set([
  'phx_join',
  'phx_leave',
  'phx_reply',
  'phx_error',
  'phx_close',
])

/** The frame type: a Phoenix event, the socket heartbeat, otherwise `push`. */
function frameOf(parsed: PhoenixMessage): string {
  if (PHOENIX_EVENTS.has(parsed.event))
    return parsed.event
  return parsed.topic === 'phoenix' && parsed.event === 'heartbeat'
    ? 'heartbeat'
    : 'push'
}

/**
 * Only Phoenix sends these: a join or its reply, or the heartbeat on the `phoenix` topic. A
 * plain five-element array (`[ts, seq, "BTC-USD", "trade", {…}]`) has the same shape, so the
 * shape alone is not enough without a hint from the URL.
 */
function isPhoenixOnly(parsed: PhoenixMessage): boolean {
  return parsed.event === 'phx_join' || parsed.event === 'phx_reply' || (parsed.topic === 'phoenix' && parsed.event === 'heartbeat')
}

class PhoenixSession implements DecoderSession {
  private serializer: string | null = null

  read(frame: RawFrame): DecodedMessage[] | null {
    if (frame.binary)
      return null
    const parsed = readMessage(parseJson(frame.data))
    if (parsed === null)
      return null
    this.serializer ??= parsed.form === 'array'
      ? '2.0.0'
      : '1.0.0'
    const empty = isRecord(parsed.payload) && Object.keys(parsed.payload).length === 0
    return [
      message({
        data: frame.data,
        frame: frameOf(parsed),
        name: [parsed.topic, parsed.event],
        separator: ':',
        // By the fixed frame type, never by the site's event text (`constructor` is a key of every object).
        role: ROLES[frameOf(parsed)] ?? null,
        wire: parsed.form === 'array'
          ? '[<joinRef>,<ref>,"{0}","{1}",<payload>]'
          : '{"topic":"{0}","event":"{1}","payload":<payload>,"ref":<ref>}',
        payload: empty
          ? undefined
          : parsed.payload,
        strong: isPhoenixOnly(parsed),
      }),
    ]
  }

  version(): string | null {
    return this.serializer
  }
}

export const phoenix: ProtocolDecoder = {
  id: 'phoenix',
  hint: (handshake: Handshake) => {
    const vsn = handshake.query.find(param => param.name === 'vsn')?.value
    return /\/websocket$/.test(handshake.path) && vsn !== undefined && /^\d+\.\d+\.\d+$/.test(vsn)
      ? `URL path ends in /websocket, vsn=${vsn}`
      : null
  },
  handshakeVersion: (handshake) => {
    const vsn = handshake.query.find(param => param.name === 'vsn')?.value
    return vsn !== undefined && /^\d+\.\d+\.\d+$/.test(vsn)
      ? vsn
      : null
  },
  start: () => new PhoenixSession(),
}
