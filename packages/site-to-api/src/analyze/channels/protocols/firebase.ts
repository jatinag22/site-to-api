/**
 * The Firebase Realtime Database wire protocol (decision 0050), as the open-source JavaScript SDK
 * speaks it (`PersistentConnection`, `WebSocketConnection`). Every frame is `{"t": "d" | "c",
 * "d": …}`: `c` frames are the transport's control messages (`h` server hello, `p`/`o` ping and
 * pong, `r` reset to another host, `s` shutdown, `e` error), `d` frames carry data:
 * - a client request `{"r": 1, "a": "q", "b": {"p": "/v0/item/42", "h": ""}}`, `a` being the
 *   action (`q` listen, `n` unlisten, `p` put, `m` merge, `o`/`om`/`oc` on-disconnect put,
 *   merge and cancel, `g` get, `auth`/`gauth`/`unauth`, `appcheck`/`unappcheck`, `s` stats);
 * - the server's answer to request `r`: `{"r": 1, "b": {"s": "ok", "d": …}}`;
 * - a server push `{"a": "d", "b": {"p": path, "d": data}}` (`d` data, `m` merge, `c` listen
 *   revoked, `ac` auth revoked, `apc` App Check revoked, `sd` security debug, `rm` range merge).
 * A message larger than one frame is sent as a frame holding only the number of frames that
 * follow, then the pieces of its JSON.
 *
 * Messages are named by action and templated path (`listen /v0/item/{id}`); an answer is named
 * after the request it answers. Credentials (`auth` and `gauth` `cred`, App Check `token`) are
 * protocol secrets for the redactor.
 */
import type { MessageRole } from '../../../model'
import type { DecodedMessage, DecoderSession, Handshake, ProtocolDecoder, RawFrame } from './types'
import { isRecord, message, parseJson } from './types'

/** Client actions and the words they are named by. */
const ACTIONS: ReadonlyMap<string, { name: string, role: MessageRole | null }> = new Map([
  [
    'q',
    { name: 'listen', role: 'subscribe' },
  ],
  [
    'n',
    { name: 'unlisten', role: 'unsubscribe' },
  ],
  [
    'p',
    { name: 'put', role: 'data' },
  ],
  [
    'm',
    { name: 'merge', role: 'data' },
  ],
  [
    'o',
    { name: 'onDisconnectPut', role: 'data' },
  ],
  [
    'om',
    { name: 'onDisconnectMerge', role: 'data' },
  ],
  [
    'oc',
    { name: 'onDisconnectCancel', role: 'data' },
  ],
  [
    'g',
    { name: 'get', role: 'data' },
  ],
  [
    'auth',
    { name: 'auth', role: 'auth' },
  ],
  [
    'gauth',
    { name: 'gauth', role: 'auth' },
  ],
  [
    'unauth',
    { name: 'unauth', role: 'unsubscribe' },
  ],
  [
    'appcheck',
    { name: 'appcheck', role: 'auth' },
  ],
  [
    'unappcheck',
    { name: 'unappcheck', role: 'data' },
  ],
  [
    's',
    { name: 'stats', role: 'data' },
  ],
])

/** Server pushes. */
const PUSHES: ReadonlyMap<string, string> = new Map([
  ['d', 'data'],
  ['m', 'merge'],
  ['c', 'listenRevoked'],
  ['ac', 'authRevoked'],
  ['apc', 'appCheckRevoked'],
  ['sd', 'securityDebug'],
  ['rm', 'rangeMerge'],
])

/** Control frames, by `d.t`. */
const CONTROLS: ReadonlyMap<string, { frame: string, role: MessageRole }> = new Map([
  [
    'h',
    { frame: 'hello', role: 'init' },
  ],
  [
    'p',
    { frame: 'ping', role: 'keepalive' },
  ],
  [
    'o',
    { frame: 'pong', role: 'keepalive' },
  ],
  [
    'r',
    { frame: 'reset', role: 'data' },
  ],
  [
    's',
    { frame: 'shutdown', role: 'data' },
  ],
  [
    'e',
    { frame: 'error', role: 'data' },
  ],
  [
    'n',
    { frame: 'endTransmission', role: 'data' },
  ],
  [
    'a',
    { frame: 'switchAck', role: 'data' },
  ],
])

/** A message split over more frames than this is not one a site sends. */
const MAX_FRAGMENTS = 1000
/** Nor is a reassembled message longer than this. */
const MAX_REASSEMBLED = 10 * 1024 * 1024
/** Requests remembered per connection, so an answer can be named. */
const MAX_PENDING = 10_000

/** Values that are credentials by their place: an auth `cred`, an App Check `token`. */
function credentials(action: string, body: Record<string, unknown>): string[] {
  const key = action === 'auth' || action === 'gauth'
    ? 'cred'
    : action === 'appcheck'
      ? 'token'
      : null
  const value = key === null
    ? undefined
    : body[key]
  return typeof value === 'string' && value !== ''
    ? [value]
    : []
}

function pathOf(body: Record<string, unknown>): string | null {
  return typeof body.p === 'string'
    ? body.p === ''
      ? '/'
      : body.p
    : null
}

interface Fragments {
  remaining: number
  parts: string[]
  length: number
}

class FirebaseSession implements DecoderSession {
  /** The previous session id the client reconnects with (`ls` in the URL), until reported. */
  private lastSession: string | null

  constructor(handshake: Handshake | undefined) {
    const ls = handshake?.query.find(param => param.name === 'ls')?.value
    this.lastSession = ls === undefined || ls === ''
      ? null
      : ls
  }

  /** The name of each request, by request number and the direction its answer comes from. */
  private readonly requests = new Map<string, string>()
  private readonly fragments: Partial<Record<RawFrame['direction'], Fragments>> = {}
  private protocolVersion: string | null = null

  read(frame: RawFrame): DecodedMessage[] | null {
    if (frame.binary)
      return null
    const piece = this.reassembled(frame)
    if (piece === null)
      return null
    // A frame count or a piece of a split message is understood but holds no message of its
    // own; the pieces count once, as the reassembled message. A piece is never written as it
    // is: a secret split over two pieces would reach the output whole in neither.
    if (piece.kind === 'piece')
      return []
    const text = piece.text
    const json = parseJson(text)
    const decoded = !isRecord(json) || Object.keys(json).length !== 2 || (json.t !== 'd' && json.t !== 'c')
      ? null
      : json.t === 'c'
        ? this.control(text, json.d)
        : this.data(frame, text, json.d)
    if (decoded !== null)
      return [decoded]
    // Pieces that do not make a Firebase message are dropped, not shown as their last piece.
    return piece.kind === 'whole'
      ? null
      : []
  }

  version(): string | null {
    return this.protocolVersion === null
      ? null
      : `v${this.protocolVersion}`
  }

  /**
   * What a frame holds: a whole message, a piece (or the frame count) of a split one, the
   * reassembled text on its last piece, or null when the frame breaks the fragment rules.
   */
  private reassembled(frame: RawFrame): { kind: 'whole' | 'joined', text: string } | { kind: 'piece' } | null {
    const pending = this.fragments[frame.direction]
    if (pending !== undefined) {
      pending.parts.push(frame.data)
      pending.length += frame.data.length
      pending.remaining--
      if (pending.length > MAX_REASSEMBLED) {
        this.fragments[frame.direction] = undefined
        return { kind: 'piece' }
      }
      if (pending.remaining > 0)
        return { kind: 'piece' }
      this.fragments[frame.direction] = undefined
      return {
        kind: 'joined',
        text: pending.parts.join(''),
      }
    }
    if (/^\d{1,4}$/.test(frame.data)) {
      const count = Number(frame.data)
      if (count < 1 || count > MAX_FRAGMENTS)
        return null
      this.fragments[frame.direction] = { remaining: count, parts: [], length: 0 }
      return { kind: 'piece' }
    }
    return { kind: 'whole', text: frame.data }
  }

  private control(data: string, body: unknown): DecodedMessage | null {
    if (!isRecord(body) || typeof body.t !== 'string')
      return null
    const control = CONTROLS.get(body.t)
    if (control === undefined)
      return null
    const hello = body.t === 'h' && isRecord(body.d) && typeof body.d.ts === 'number' && typeof body.d.v === 'string'
    if (hello && isRecord(body.d) && typeof body.d.v === 'string' && /^\d{1,3}$/.test(body.d.v))
      this.protocolVersion = body.d.v
    // The hello's session id `s` and the `ls` the client reconnected with follow one browser
    // session from connection to connection: secrets for the redactor.
    const session = hello && isRecord(body.d) && typeof body.d.s === 'string' && body.d.s !== ''
      ? [body.d.s]
      : []
    const last = this.lastSession === null
      ? []
      : [this.lastSession]
    this.lastSession = null
    return message({
      data,
      frame: control.frame,
      name: [control.frame],
      role: control.role,
      wire: `{"t":"c","d":{"t":"${body.t}","d":<payload>}}`,
      payload: body.d,
      strong: hello,
      secrets: [
        ...session,
        ...last,
      ],
    })
  }

  private data(frame: RawFrame, text: string, body: unknown): DecodedMessage | null {
    if (!isRecord(body))
      return null
    const request = typeof body.r === 'number' && Number.isSafeInteger(body.r)
      ? String(body.r)
      : null
    const inner = body.b
    if (!isRecord(inner))
      return null
    if (frame.direction === 'sent')
      return this.request(text, body, request, inner)
    return typeof body.a === 'string'
      ? this.push(text, body.a, inner, request)
      : this.answer(text, request, inner)
  }

  private request(data: string, body: Record<string, unknown>, request: string | null, inner: Record<string, unknown>): DecodedMessage | null {
    if (typeof body.a !== 'string' || request === null || Object.keys(body).some(key => key !== 'r' && key !== 'a' && key !== 'b'))
      return null
    const action = ACTIONS.get(body.a)
    if (action === undefined)
      return null
    const path = pathOf(inner)
    const name = path === null
      ? [action.name]
      : [action.name, path]
    if (this.requests.size < MAX_PENDING)
      this.requests.set(request, name.join('\u0000'))
    return message({
      data,
      frame: action.name,
      name,
      separator: ' ',
      role: action.role,
      wire: `{"t":"d","d":{"r":<request>,"a":"${body.a}","b":<payload>}}`,
      payload: inner,
      strong: true,
      secrets: credentials(body.a, inner),
    })
  }

  private push(data: string, action: string, inner: Record<string, unknown>, request: string | null): DecodedMessage | null {
    const push = PUSHES.get(action)
    if (push === undefined || request !== null)
      return null
    const path = pathOf(inner)
    return message({
      data,
      frame: push,
      name: path === null
        ? [push]
        : [push, path],
      separator: ' ',
      role: 'data',
      wire: `{"t":"d","d":{"a":"${action}","b":<payload>}}`,
      payload: 'd' in inner
        ? inner.d
        : inner,
      strong: path !== null,
    })
  }

  private answer(data: string, request: string | null, inner: Record<string, unknown>): DecodedMessage | null {
    if (request === null || typeof inner.s !== 'string')
      return null
    const asked = this.requests.get(request)
    return message({
      data,
      frame: inner.s === 'ok'
        ? 'response'
        : 'error',
      name: asked === undefined
        ? ['response']
        : asked.split('\u0000'),
      separator: ' ',
      role: 'data',
      wire: '{"t":"d","d":{"r":<request>,"b":<payload>}}',
      payload: inner,
      strong: asked !== undefined,
    })
  }
}

export const firebase: ProtocolDecoder = {
  id: 'firebase',
  content: 'text',
  hint: (handshake: Handshake) => {
    const names = new Set(handshake.query.map(param => param.name))
    return /\/\.ws$/.test(handshake.path) && names.has('ns') && names.has('v')
      ? 'URL path /.ws with ns and v query parameters'
      : null
  },
  handshakeVersion: (handshake: Handshake) => {
    const version = handshake.query.find(param => param.name === 'v')?.value
    return version !== undefined && /^\d{1,3}$/.test(version)
      ? `v${version}`
      : null
  },
  start: handshake => new FirebaseSession(handshake),
}
