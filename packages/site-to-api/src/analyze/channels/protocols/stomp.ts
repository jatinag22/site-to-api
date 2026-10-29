/**
 * STOMP 1.0-1.2 (decision 0038): a command line, `name:value` header lines, a blank line, a body
 * and a NUL byte. A frame holding only line breaks is a heart-beat. Header values are unescaped
 * (`\c` `\n` `\r` `\\`) and, like every payload, redacted later: `passcode` and `Authorization`
 * are secret names.
 */
import type { DecodedMessage, DecoderSession, Handshake, ProtocolDecoder, RawFrame } from './types'
import { message, parseJson } from './types'

const CLIENT_COMMANDS = new Set([
  'CONNECT',
  'STOMP',
  'SEND',
  'SUBSCRIBE',
  'UNSUBSCRIBE',
  'ACK',
  'NACK',
  'BEGIN',
  'COMMIT',
  'ABORT',
  'DISCONNECT',
])
const SERVER_COMMANDS = new Set([
  'CONNECTED',
  'MESSAGE',
  'RECEIPT',
  'ERROR',
])
/** Commands named after their destination, so each destination is its own message type. */
const BY_DESTINATION = new Set([
  'SEND',
  'SUBSCRIBE',
  'UNSUBSCRIBE',
  'MESSAGE',
])
const AUTH_HEADERS = new Set(['login', 'passcode', 'authorization'])

function unescapeHeader(value: string): string {
  return value.replace(/\\([cnr\\])/g, (_, char: string) => ({
    'c': ':',
    'n': '\n',
    'r': '\r',
    '\\': '\\',
  })[char] ?? char)
}

interface StompFrame {
  command: string
  headers: Record<string, string>
  body: string
}

function readFrame(text: string): StompFrame | null {
  const trimmed = text.replace(/^(?:\r?\n)+/, '')
  const end = trimmed.indexOf('\0')
  if (end === -1 || trimmed.slice(end + 1).replace(/[\r\n]/g, '') !== '')
    return null
  const content = trimmed.slice(0, end)
  const split = /\r?\n\r?\n/.exec(content)
  const head = split === null
    ? content
    : content.slice(0, split.index)
  const body = split === null
    ? ''
    : content.slice(split.index + split[0].length)
  const [command = '', ...lines] = head.split(/\r?\n/)
  if (!CLIENT_COMMANDS.has(command) && !SERVER_COMMANDS.has(command))
    return null
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0)
      return null
    const name = unescapeHeader(line.slice(0, colon))
    // The first occurrence of a repeated header wins (STOMP 1.2).
    if (!Object.hasOwn(headers, name))
      headers[name] = unescapeHeader(line.slice(colon + 1))
  }
  return { command, headers, body }
}

function roleOf(frame: StompFrame): DecodedMessage['role'] {
  switch (frame.command) {
    case 'CONNECT':
    case 'STOMP':
      return Object.keys(frame.headers).some(name => AUTH_HEADERS.has(name.toLowerCase()))
        ? 'auth'
        : 'init'
    case 'SUBSCRIBE':
      return 'subscribe'
    case 'UNSUBSCRIBE':
    case 'DISCONNECT':
      return 'unsubscribe'
    case 'SEND':
      return null
    default:
      return 'data'
  }
}

class StompSession implements DecoderSession {
  private protocolVersion: string | null = null

  read(frame: RawFrame): DecodedMessage[] | null {
    if (frame.binary)
      return null
    if (/^(?:\r?\n)+$/.test(frame.data)) {
      return [
        message({
          data: frame.data,
          frame: 'heart-beat',
          name: ['heart-beat'],
          role: 'keepalive',
          wire: '\\n',
          payload: undefined,
          strong: false,
        }),
      ]
    }
    const parsed = readFrame(frame.data)
    if (parsed === null)
      return null
    const version = parsed.headers.version ?? parsed.headers['accept-version']
    if (version !== undefined && (parsed.command === 'CONNECTED' || this.protocolVersion === null))
      this.protocolVersion = version
    const destination = parsed.headers.destination
    const named = BY_DESTINATION.has(parsed.command) && destination !== undefined
    const { destination: _destination, ...headers } = parsed.headers
    const json = parsed.body === ''
      ? undefined
      : parseJson(parsed.body)
    const headerNames = Object.keys(headers)
    return [
      message({
        data: frame.data,
        frame: parsed.command,
        name: [
          named
            ? destination
            : parsed.command,
        ],
        role: roleOf(parsed),
        wire: `${parsed.command}\\n${named
          ? 'destination:{0}\\n'
          : ''}${headerNames.map(name => `${name}:…\\n`).join('')}\\n${parsed.body === ''
          ? ''
          : '<body>'}\\0`,
        payload: {
          ...(headerNames.length > 0
            ? { headers }
            : {}),
          ...(parsed.body === ''
            ? {}
            : { body: json ?? parsed.body }),
        },
        strong: true,
      }),
    ]
  }

  version(): string | null {
    return this.protocolVersion
  }
}

export const stomp: ProtocolDecoder = {
  id: 'stomp',
  hint: (handshake: Handshake) => {
    const subprotocol = handshake.subprotocols.find(value => /^v1\d\.stomp$|^stomp$/i.test(value))
    return subprotocol === undefined
      ? null
      : `subprotocol ${subprotocol}`
  },
  handshakeVersion: () => null,
  start: () => new StompSession(),
}
