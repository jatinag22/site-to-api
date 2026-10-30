/**
 * Primus (decision 0050): a socket wrapper whose messages are JSON values. Its own heartbeat is
 * the JSON strings `"primus::ping::<ms>"` and `"primus::pong::<ms>"`; everything else is the
 * application's data. Primus runs over a transformer: with the Engine.IO one each frame is an
 * Engine.IO packet (`0{…}` open, `2`/`3` ping and pong, `5` upgrade, `4<json>` a Primus message),
 * with the plain WebSocket one each frame is the JSON itself. Primus messages have no name of
 * their own, so a data message is named by the first string among its `type`, `event`,
 * `action`, `method`, `op`, `cmd`, `command`, `name` and `topic` fields, else `message`.
 */
import type { DecodedMessage, DecoderSession, Handshake, ProtocolDecoder, RawFrame } from './types'
import { isRecord, message, parseJson } from './types'

const NAME_FIELDS: readonly string[] = [
  'type',
  'event',
  'action',
  'method',
  'op',
  'cmd',
  'command',
  'name',
  'topic',
]

const HEARTBEAT = /^primus::(ping|pong)::\d{1,16}$/

/** The field that names a data message, and its value. */
function namedBy(json: unknown): { field: string, value: string } | null {
  if (!isRecord(json))
    return null
  for (const field of NAME_FIELDS) {
    const value = json[field]
    if (typeof value === 'string' && value !== '' && value.length <= 200)
      return { field, value }
  }
  return null
}

/** One Primus message: its JSON text and the wire prefix around it (`4` over Engine.IO). */
function primusMessage(data: string, text: string, prefix: string): DecodedMessage | null {
  const json = parseJson(text)
  if (json === undefined)
    return null
  if (typeof json === 'string') {
    const heartbeat = HEARTBEAT.exec(json)
    if (heartbeat !== null) {
      const kind = heartbeat[1] ?? 'ping'
      return message({
        data,
        frame: kind,
        name: [kind],
        role: 'keepalive',
        wire: `${prefix}"primus::${kind}::<ms>"`,
        payload: undefined,
        strong: true,
      })
    }
  }
  const named = namedBy(json)
  return message({
    data,
    frame: 'message',
    name: [named?.value ?? 'message'],
    role: null,
    wire: named === null
      ? `${prefix}<payload>`
      : `${prefix}{"${named.field}":"{0}",…}`,
    payload: json,
    strong: false,
  })
}

const BARE_PACKETS: Readonly<Record<string, string>> = { 1: 'close', 5: 'upgrade', 6: 'noop' }

/** Engine.IO packets other than `4`, which carry no Primus message. */
function engineControl(data: string): DecodedMessage | null {
  const type = data.charAt(0)
  const rest = data.slice(1)
  if (type === '0') {
    const json = parseJson(rest)
    return isRecord(json) && typeof json.sid === 'string'
      ? message({
          data,
          frame: 'open',
          name: ['open'],
          role: 'init',
          wire: '0<payload>',
          payload: json,
          strong: false,
        })
      : null
  }
  if ((type === '2' || type === '3') && (rest === '' || rest === 'probe')) {
    const frame = type === '2'
      ? 'ping'
      : 'pong'
    return message({
      data,
      frame,
      name: [frame],
      role: 'keepalive',
      wire: data,
      payload: undefined,
      strong: false,
    })
  }
  const bare = BARE_PACKETS[type]
  return bare === undefined || rest !== ''
    ? null
    : message({
        data,
        frame: bare,
        name: [bare],
        role: type === '1'
          ? 'unsubscribe'
          : 'keepalive',
        wire: data,
        payload: undefined,
        strong: false,
      })
}

class PrimusSession implements DecoderSession {
  /** Whether this connection's frames are Engine.IO packets, decided by its first frame. */
  private engine: boolean | null = null

  read(frame: RawFrame): DecodedMessage[] | null {
    if (frame.binary)
      return null
    const { data } = frame
    // Plain-transformer frames are JSON (`{`, `[`, `"`); Engine.IO packets start with their type digit.
    this.engine ??= /^[0-6]/.test(data)
    const decoded = this.engine
      ? data.startsWith('4')
        ? primusMessage(data, data.slice(1), '4')
        : engineControl(data)
      : primusMessage(data, data, '')
    return decoded === null
      ? null
      : [decoded]
  }

  version(): string | null {
    return this.engine === true
      ? 'Engine.IO transformer'
      : this.engine === false
        ? 'WebSocket transformer'
        : null
  }
}

export const primus: ProtocolDecoder = {
  id: 'primus',
  content: 'text',
  hint: (handshake: Handshake) => /(?:^|\/)primus[\w-]*\/?$/i.test(handshake.path) || handshake.query.some(param => param.name === '_primuscb')
    ? 'URL path or _primuscb query parameter names Primus'
    : null,
  handshakeVersion: () => null,
  start: () => new PrimusSession(),
}
