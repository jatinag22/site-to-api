/**
 * Socket.IO over Engine.IO v3 and v4 (decision 0038). An Engine.IO packet is one digit and data:
 * `0{…}` open, `1` close, `2`/`3` ping and pong (`2probe` while upgrading), `4…` a Socket.IO
 * packet, `5` upgrade, `6` noop. A Socket.IO packet is a digit, an attachment count for binary
 * packets (`451-`), a namespace (`/chat,`), an ack id and JSON: `40` connect (with the auth
 * payload), `41` disconnect, `42["event", …args]`, `43[…]` an ack, `44` a connect error,
 * `45`/`46` binary events and acks whose attachments follow as binary frames.
 */
import type { DecodedMessage, DecoderSession, Handshake, ProtocolDecoder, RawFrame } from './types'
import { argumentsPayload, isRecord, message, parseJson } from './types'

/** Name parts and the wire prefix for a namespace: the default `/` is left out on the wire. */
function namespaced(namespace: string, name: string): { name: string[], separator: string, ns: string, slot: number } {
  return namespace === '/'
    ? {
        name: [name],
        separator: ' ',
        ns: '',
        slot: 0,
      }
    : {
        name: [namespace, name],
        separator: ' ',
        ns: '{0},',
        slot: 1,
      }
}

interface Packet {
  type: number
  attachments: number
  namespace: string
  id: string
  json: unknown
}

/** `<type>[<attachments>-][/<namespace>,][<id>][<json>]`, or null when it is not one. */
function readPacket(text: string): Packet | null {
  // Socket.IO data is always a JSON object or array, so it starts with `{` or `[`.
  const match = /^([0-6])(?:(\d+)-)?(\/[^,]*(?:,|$))?(\d*)([[{][\s\S]*)?$/.exec(text)
  if (match === null)
    return null
  const [, type = '', attachments = '', rawNamespace = '', id = '', rest = ''] = match
  const json = rest === ''
    ? undefined
    : parseJson(rest)
  if (rest !== '' && json === undefined)
    return null
  const binary = type === '5' || type === '6'
  if (binary !== (attachments !== ''))
    return null
  return {
    type: Number(type),
    attachments: attachments === ''
      ? 0
      : Number(attachments),
    namespace: rawNamespace === ''
      ? '/'
      : rawNamespace.replace(/,$/, ''),
    id,
    json,
  }
}

const OTHER_SIDE = { sent: 'received', received: 'sent' } as const

/** Engine.IO packets that are only their type digit. */
const BARE_PACKETS: Record<string, { frame: string, role: DecodedMessage['role'] }> = {
  1: { frame: 'close', role: 'unsubscribe' },
  5: { frame: 'upgrade', role: 'init' },
  6: { frame: 'noop', role: 'keepalive' },
}

function controlMessage(data: string, frame: string, role: DecodedMessage['role']): DecodedMessage {
  return message({
    data,
    frame,
    name: [frame],
    role,
    wire: data,
    payload: undefined,
    strong: false,
  })
}

/** `0{"sid":…}`: the server opening the Engine.IO session. */
function openMessage(data: string, rest: string): DecodedMessage | null {
  const json = parseJson(rest)
  return isRecord(json) && typeof json.sid === 'string'
    ? message({
        data,
        frame: 'open',
        name: ['open'],
        role: 'init',
        wire: '0<payload>',
        payload: json,
        strong: true,
      })
    : null
}

class SocketIoSession implements DecoderSession {
  /** Event name per ack id, keyed by the direction that will send the ack. */
  private readonly acks = {
    sent: new Map<string, string>(),
    received: new Map<string, string>(),
  }

  /** Binary attachments still to come, per direction, and the event they belong to. */
  private readonly pending = { sent: [] as string[], received: [] as string[] }
  private pingFromServer = false
  private pingFromClient = false

  read(frame: RawFrame): DecodedMessage[] | null {
    if (frame.binary) {
      const event = this.pending[frame.direction].shift()
      return event === undefined
        ? null
        : [
            message({
              data: frame.data,
              binary: true,
              frame: 'attachment',
              name: [event],
              role: 'data',
              wire: '<binary attachment>',
              payload: undefined,
              strong: true,
            }),
          ]
    }
    const decoded = this.readEngine(frame)
    return decoded === null
      ? null
      : [decoded]
  }

  version(): string | null {
    if (this.pingFromServer)
      return 'Engine.IO 4'
    return this.pingFromClient
      ? 'Engine.IO 3'
      : null
  }

  private readEngine(frame: RawFrame): DecodedMessage | null {
    const { data } = frame
    const type = data.charAt(0)
    const rest = data.slice(1)
    if (type === '4')
      return this.readSocketIo(frame, rest)
    if (type === '0')
      return openMessage(data, rest)
    if (type === '2' || type === '3')
      return this.heartbeat(frame, type, rest)
    const bare = BARE_PACKETS[type]
    return bare === undefined || rest !== ''
      ? null
      : controlMessage(data, bare.frame, bare.role)
  }

  /** `2` and `3`, plain or `probe`; who pings first tells Engine.IO 4 (server) from 3 (client). */
  private heartbeat(frame: RawFrame, type: '2' | '3', rest: string): DecodedMessage | null {
    if (rest !== '' && rest !== 'probe')
      return null
    if (type === '2' && rest === '') {
      if (frame.direction === 'received')
        this.pingFromServer = true
      else
        this.pingFromClient = true
    }
    return controlMessage(frame.data, type === '2'
      ? 'ping'
      : 'pong', 'keepalive')
  }

  private readSocketIo(frame: RawFrame, text: string): DecodedMessage | null {
    const packet = readPacket(text)
    if (packet === null)
      return null
    switch (packet.type) {
      case 0:
        return connectMessage(frame, packet)
      case 1: {
        const names = namespaced(packet.namespace, 'disconnect')
        return message({
          data: frame.data,
          frame: 'disconnect',
          ...names,
          role: 'unsubscribe',
          wire: `41${names.ns}`,
          payload: undefined,
          strong: false,
        })
      }
      case 2:
      case 5:
        return this.eventMessage(frame, packet)
      case 3:
      case 6:
        return this.ackMessage(frame, packet)
      case 4: {
        const names = namespaced(packet.namespace, 'connect_error')
        return message({
          data: frame.data,
          frame: 'connect_error',
          ...names,
          role: 'data',
          wire: `44${names.ns}<payload>`,
          payload: packet.json,
          strong: false,
        })
      }
      default:
        return null
    }
  }

  /** `42["event", …args]` and `45<n>-[…]`; remembers the ack id and announced attachments. */
  private eventMessage(frame: RawFrame, packet: Packet): DecodedMessage | null {
    const args = packet.json
    if (!Array.isArray(args) || typeof args[0] !== 'string')
      return null
    const event = args[0]
    const names = namespaced(packet.namespace, event)
    if (packet.id !== '')
      this.acks[OTHER_SIDE[frame.direction]].set(`${packet.namespace} ${packet.id}`, event)
    for (let i = 0; i < packet.attachments; i++)
      this.pending[frame.direction].push(event)
    const prefix = packet.type === 2
      ? '42'
      : `45${packet.attachments}-`
    const id = packet.id === ''
      ? ''
      : '<ackId>'
    const rest = args.length > 1
      ? ',<payload>'
      : ''
    return message({
      data: frame.data,
      frame: packet.type === 2
        ? 'event'
        : 'binary event',
      ...names,
      role: null,
      wire: `${prefix}${names.ns}${id}["{${names.slot}}"${rest}]`,
      payload: argumentsPayload(args.slice(1)),
      strong: true,
    })
  }

  /** `43<id>[…]` and `46<n>-<id>[…]`, named after the event they answer. */
  private ackMessage(frame: RawFrame, packet: Packet): DecodedMessage | null {
    if (!Array.isArray(packet.json) || packet.id === '')
      return null
    const event = this.acks[frame.direction].get(`${packet.namespace} ${packet.id}`) ?? 'ack'
    const names = namespaced(packet.namespace, event)
    if (packet.type === 6) {
      for (let i = 0; i < packet.attachments; i++)
        this.pending[frame.direction].push(event)
    }
    const prefix = packet.type === 3
      ? '43'
      : `46${packet.attachments}-`
    return message({
      data: frame.data,
      frame: 'ack',
      ...names,
      role: 'data',
      wire: `${prefix}${names.ns}<ackId>[<payload>]`,
      payload: argumentsPayload(packet.json),
      strong: true,
    })
  }
}

/** `40` with the auth payload (client) or the socket id (server). */
function connectMessage(frame: RawFrame, packet: Packet): DecodedMessage | null {
  if (packet.json !== undefined && !isRecord(packet.json))
    return null
  const names = namespaced(packet.namespace, 'connect')
  const payload = isRecord(packet.json)
    ? packet.json
    : null
  const auth = frame.direction === 'sent' && payload !== null && Object.keys(payload).length > 0
  return message({
    data: frame.data,
    frame: 'connect',
    ...names,
    role: auth
      ? 'auth'
      : 'init',
    wire: `40${names.ns}${payload === null
      ? ''
      : '<payload>'}`,
    payload: packet.json,
    strong: payload !== null && typeof payload.sid === 'string',
  })
}

function engineVersion(handshake: Handshake): string | null {
  const eio = handshake.query.find(param => param.name === 'EIO')?.value
  return eio === '3' || eio === '4'
    ? eio
    : null
}

export const socketIo: ProtocolDecoder = {
  id: 'socket.io',
  hint: (handshake) => {
    if (/\/socket\.io\/?$/.test(handshake.path))
      return `URL path ${handshake.path}`
    const eio = engineVersion(handshake)
    return eio === null
      ? null
      : `query EIO=${eio}`
  },
  handshakeVersion: (handshake) => {
    const eio = engineVersion(handshake)
    return eio === null
      ? null
      : `Engine.IO ${eio}`
  },
  start: () => new SocketIoSession(),
}

/**
 * The packets of an Engine.IO long-polling body: v4 separates them with `\x1e`, v3 prefixes each
 * with its length (`12:42["hi",1]`). Binary packets in a v4 text payload are `b<base64>`.
 */
export function pollingPackets(body: string, eio: string | null): Array<{ data: string, binary: boolean }> {
  const lengthPrefixed = eio === '3' || (eio === null && /^\d+:/.test(body))
  const packets: string[] = []
  if (lengthPrefixed) {
    let offset = 0
    while (offset < body.length) {
      const colon = body.indexOf(':', offset)
      const length = Number(body.slice(offset, colon))
      if (colon === -1 || !Number.isInteger(length) || length < 0)
        return []
      packets.push(body.slice(colon + 1, colon + 1 + length))
      offset = colon + 1 + length
    }
  }
  else {
    packets.push(...body.split('\x1E').filter(packet => packet !== ''))
  }
  // v3 writes the Engine.IO type after the `b` (`b4<base64>`); v4 binary is always a message.
  const binaryPrefix = lengthPrefixed
    ? /^b4/
    : /^b/
  return packets.map(packet => binaryPrefix.test(packet)
    ? {
        data: packet.replace(binaryPrefix, ''),
        binary: true,
      }
    : { data: packet, binary: false })
}
