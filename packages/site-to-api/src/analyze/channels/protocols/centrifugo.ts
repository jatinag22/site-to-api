/**
 * Centrifugo's JSON protocol (decision 0038). A frame holds one or more JSON objects separated by
 * line breaks. Clients send commands `{"id":1,"connect":{…}}`, `{"id":2,"subscribe":{"channel":…}}`
 * (protocol v2: `{"id":1,"method":1,"params":{…}}`); the server answers with the same `id` and
 * pushes `{"push":{"channel":…,"pub":{…}}}` (v2: `{"result":{"channel":…,"data":…}}`). `{}` is a
 * ping and its pong. Messages about a channel are named after it.
 */
import type { DecodedMessage, DecoderSession, Handshake, ProtocolDecoder, RawFrame } from './types'
import { isRecord, message, parseJson } from './types'

const COMMANDS = [
  'connect',
  'subscribe',
  'unsubscribe',
  'publish',
  'presence',
  'presence_stats',
  'history',
  'ping',
  'send',
  'rpc',
  'refresh',
  'sub_refresh',
] as const
/** Protocol v2 method numbers, in the order of {@link COMMANDS}. */
const LEGACY_METHODS: readonly string[] = COMMANDS
const ON_CHANNEL = new Set([
  'subscribe',
  'unsubscribe',
  'publish',
  'presence',
  'presence_stats',
  'history',
  'sub_refresh',
])
const PUSHES: Record<string, string> = {
  pub: 'publication',
  join: 'join',
  leave: 'leave',
  unsubscribe: 'unsubscribe',
  message: 'message',
  subscribe: 'subscribe',
  connect: 'connect',
  disconnect: 'disconnect',
  refresh: 'refresh',
}

const ROLES: Record<string, DecodedMessage['role']> = {
  subscribe: 'subscribe',
  unsubscribe: 'unsubscribe',
  ping: 'keepalive',
  refresh: 'keepalive',
  sub_refresh: 'keepalive',
}

function commandOf(json: Record<string, unknown>): { command: string, params: unknown, legacy: boolean } | null {
  const keys = Object.keys(json).filter(key => key !== 'id')
  const named = COMMANDS.find(command => keys.length === 1 && keys[0] === command)
  if (named !== undefined)
    return { command: named, params: json[named], legacy: false }
  if ((typeof json.method === 'number' || json.method === undefined) && isRecord(json.params) && keys.every(key => key === 'method' || key === 'params')) {
    const command = LEGACY_METHODS[typeof json.method === 'number'
      ? json.method
      : 0]
    return command === undefined
      ? null
      : { command, params: json.params, legacy: true }
  }
  return null
}

function channelOf(params: unknown): string | null {
  return isRecord(params) && typeof params.channel === 'string' && params.channel !== ''
    ? params.channel
    : null
}

/** A push (`{"push":{…}}`, v2 `{"result":{"channel":…}}` without an id), or null. */
function pushMessage(data: string, json: Record<string, unknown>, id: string | null): DecodedMessage | null {
  const modern = isRecord(json.push)
  const push = isRecord(json.push)
    ? json.push
    : id === null && isRecord(json.result) && typeof json.result.channel === 'string'
      ? json.result
      : null
  if (push === null)
    return null
  const kind = Object.keys(PUSHES).find(key => key in push)
  const channel = channelOf(push)
  return message({
    data,
    frame: kind === undefined
      ? 'publication'
      : PUSHES[kind] ?? kind,
    name: [channel ?? 'push'],
    role: 'data',
    wire: modern
      ? `{"push":{"channel":"{0}","${kind ?? 'pub'}":<payload>}}`
      : '{"result":{"channel":"{0}","data":<payload>}}',
    payload: kind === undefined
      ? push.data
      : push[kind],
    strong: channel !== null,
  })
}

class CentrifugoSession implements DecoderSession {
  /** Command and channel per command id, so the reply is named after the command. */
  private readonly commands = new Map<string, { command: string, channel: string | null }>()
  private legacy = false
  private modern = false

  read(frame: RawFrame): DecodedMessage[] | null {
    if (frame.binary)
      return null
    const records = frame.data.split('\n').filter(line => line.trim() !== '')
    if (records.length === 0)
      return null
    const decoded: DecodedMessage[] = []
    for (const record of records) {
      const json = parseJson(record)
      const one = isRecord(json)
        ? this.readRecord(frame, record, json)
        : null
      if (one === null)
        return null
      decoded.push(one)
    }
    return decoded
  }

  version(): string | null {
    if (this.modern === this.legacy)
      return null
    return this.modern
      ? 'v4+'
      : 'v2'
  }

  private readRecord(frame: RawFrame, data: string, json: Record<string, unknown>): DecodedMessage | null {
    if (Object.keys(json).length === 0) {
      return message({
        data,
        frame: 'ping',
        name: ['ping'],
        role: 'keepalive',
        wire: '{}',
        payload: undefined,
        strong: false,
      })
    }
    const id = typeof json.id === 'number'
      ? String(json.id)
      : null
    if (frame.direction === 'sent')
      return this.readCommand(data, json, id)
    return this.readServer(data, json, id)
  }

  private readCommand(data: string, json: Record<string, unknown>, id: string | null): DecodedMessage | null {
    const command = commandOf(json)
    if (command === null || id === null)
      return null
    if (command.legacy)
      this.legacy = true
    else
      this.modern = true
    const channel = ON_CHANNEL.has(command.command)
      ? channelOf(command.params)
      : null
    const rpcMethod = command.command === 'rpc' && isRecord(command.params) && typeof command.params.method === 'string'
      ? command.params.method
      : null
    this.commands.set(id, { command: command.command, channel })
    const token = isRecord(command.params) && typeof command.params.token === 'string' && command.params.token !== ''
    return message({
      data,
      frame: command.command,
      name: [channel ?? rpcMethod ?? command.command],
      role: command.command === 'connect'
        ? token
          ? 'auth'
          : 'init'
        : ROLES[command.command] ?? null,
      wire: command.legacy
        ? `{"id":<id>,"method":${LEGACY_METHODS.indexOf(command.command)},"params":<payload>}`
        : `{"id":<id>,"${command.command}":<payload>}`,
      payload: command.params,
      strong: command.command === 'connect' || channel !== null,
    })
  }

  private readServer(data: string, json: Record<string, unknown>, id: string | null): DecodedMessage | null {
    const pushed = pushMessage(data, json, id)
    if (pushed !== null)
      return pushed
    if (id === null)
      return null
    const command = this.commands.get(id)
    const keys = Object.keys(json).filter(key => key !== 'id')
    const resultKey = keys.length === 1
      ? keys[0]
      : undefined
    if (resultKey === undefined)
      return null
    const isError = resultKey === 'error'
    return message({
      data,
      frame: isError
        ? 'error'
        : 'reply',
      name: [
        command === undefined
          ? resultKey
          : command.channel ?? command.command,
      ],
      role: 'data',
      wire: `{"id":<id>,"${resultKey}":<payload>}`,
      payload: json[resultKey],
      strong: command !== undefined,
    })
  }
}

export const centrifugo: ProtocolDecoder = {
  id: 'centrifugo',
  hint: (handshake: Handshake) => {
    const subprotocol = handshake.subprotocols.find(value => value === 'centrifuge-json')
    if (subprotocol !== undefined)
      return `subprotocol ${subprotocol}`
    return /\/connection\/websocket$/.test(handshake.path)
      ? `URL path ${handshake.path}`
      : null
  },
  handshakeVersion: () => null,
  start: () => new CentrifugoSession(),
}
