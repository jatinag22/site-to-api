/**
 * SockJS framing, which Spring and others wrap around STOMP (decision 0038). The server sends
 * `o` (open), `h` (heart-beat), `a["…","…"]` (messages) and `c[code,"reason"]` (close); the
 * client sends `["…"]`. Unwrapping it leaves the inner protocol's frames.
 */
import type { DecodedMessage, Handshake, RawFrame } from './types'
import { message, parseJson } from './types'

/** One frame after unwrapping: an inner frame, or a SockJS control frame already decoded. */
export type Unwrapped = { frame: RawFrame, control: null } | { frame: null, control: DecodedMessage }

const CONTROL: Record<string, { frame: string, role: DecodedMessage['role'] }> = {
  o: { frame: 'sockjs open', role: 'init' },
  h: { frame: 'sockjs heartbeat', role: 'keepalive' },
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : null
}

/** The inner frames of one SockJS frame, or null when it is not one. */
function unwrapFrame(frame: RawFrame): Unwrapped[] | null {
  if (frame.binary)
    return null
  const { data, direction } = frame
  if (direction === 'sent') {
    const inner = strings(parseJson(data))
    return inner === null
      ? null
      : inner.map(text => ({
          frame: { direction, data: text, binary: false },
          control: null,
        }))
  }
  const control = CONTROL[data]
  if (control !== undefined) {
    return [
      {
        frame: null,
        control: message({
          data,
          frame: control.frame,
          name: [control.frame],
          role: control.role,
          wire: data,
          payload: undefined,
          strong: true,
        }),
      },
    ]
  }
  if (data.startsWith('c[')) {
    const payload = parseJson(data.slice(1))
    return Array.isArray(payload)
      ? [
          {
            frame: null,
            control: message({
              data,
              frame: 'sockjs close',
              name: ['sockjs close'],
              role: 'unsubscribe',
              wire: 'c<payload>',
              payload,
              strong: true,
            }),
          },
        ]
      : null
  }
  const inner = data.startsWith('a[')
    ? strings(parseJson(data.slice(1)))
    : data.startsWith('m"')
      ? [
          parseJson(data.slice(1)),
        ].filter(item => typeof item === 'string')
      : null
  return inner === null
    ? null
    : inner.map(text => ({
        frame: { direction, data: text, binary: false },
        control: null,
      }))
}

/** `/<prefix>/<server>/<session>/websocket`: the SockJS WebSocket transport URL. */
function sockjsHint(handshake: Handshake): boolean {
  return /\/\d{3}\/[^/]+\/websocket$/.test(handshake.path)
}

/**
 * The frames unwrapped, per captured frame, when the connection is SockJS: the URL says so or
 * the server opened with `o`, and every text frame unwraps. Null otherwise.
 */
export function unwrapSockjs(frames: readonly RawFrame[], handshake: Handshake): Unwrapped[][] | null {
  const opened = frames.find(frame => frame.direction === 'received')?.data === 'o'
  if (!opened && !sockjsHint(handshake))
    return null
  const unwrapped: Unwrapped[][] = []
  for (const frame of frames) {
    const inner = unwrapFrame(frame)
    if (inner === null)
      return null
    unwrapped.push(inner)
  }
  return unwrapped
}
