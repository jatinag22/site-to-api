/**
 * The contract every framing-protocol decoder implements (decision 0038). A decoder reads one
 * connection's frames in order, so it can keep state: an ack names the event it answers, a
 * graphql-ws `next` the operation its `subscribe` started, a Socket.IO binary attachment the
 * event that announced it.
 */
import type { ChannelProtocolId, MessageRole } from '../../../model'

/** A frame as captured: text, or binary as base64. */
export interface RawFrame {
  direction: 'sent' | 'received'
  data: string
  binary: boolean
}

/** One protocol message read from a frame (a frame can hold several: SignalR, Centrifugo). */
export interface DecodedMessage {
  /** The message's own text (one record of the frame), or the binary frame's base64. */
  data: string
  binary: boolean
  /** Protocol frame type: `event`, `ack`, `SEND`, `next`, ... */
  frame: string
  /**
   * The parts of the protocol-level name, as sent: one part (`chat message`), or two for Phoenix
   * (`room:42`, `phx_join`). Each part is templated and redacted before it is written.
   */
  name: string[]
  /** How the parts join into one name: `:` for Phoenix `topic:event`, otherwise unused. */
  separator: string
  /** What the message does; null leaves it to the words of the name (decision 0030). */
  role: MessageRole | null
  /**
   * The frame on the wire with `{0}`, `{1}` for the name parts, `{k0}`, `{k1}` for
   * {@link wireKeys} and `<payload>` for the payload, e.g. `42["{0}",<payload>]`.
   */
  wire: string
  /**
   * Key names from the site that the wire template shows (STOMP header names, a Centrifugo
   * reply key); like name parts, they are redacted before the template is written.
   */
  wireKeys: string[]
  /** The message's data, read as JSON: what its schema is inferred from; undefined when none. */
  payload: unknown
  /**
   * Values that are credentials by their place in the protocol although their names do not say
   * so (an SFS2X login's `un` and `pw`); the redactor scrubs them wherever they appear.
   */
  secrets: string[]
  /** True for messages only this protocol sends (`0{"sid":…}`, a STOMP frame); one is enough to detect it. */
  strong: boolean
}

/** What the upgrade request and URL say about the protocol. */
export interface Handshake {
  path: string
  query: ReadonlyArray<{ name: string, value: string }>
  /** `Sec-WebSocket-Protocol` values the browser asked for. */
  subprotocols: readonly string[]
}

/** A decoder's reading of a whole connection. */
export interface DecoderSession {
  /** The messages of one frame, or null when the frame is not this protocol's. */
  read: (frame: RawFrame) => DecodedMessage[] | null
  /** The protocol version the frames showed, if any. */
  version: () => string | null
}

export interface ProtocolDecoder {
  id: ChannelProtocolId
  /**
   * Which frames carry the protocol: `text` (detection counts the text frames it understood) or
   * `binary` (SFS2X: the binary frames).
   */
  content: 'text' | 'binary'
  /** Evidence from the URL or subprotocol (`URL path ends in /socket.io/`), or null. */
  hint: (handshake: Handshake) => string | null
  /** The version the handshake names (`EIO=4`), if any. */
  handshakeVersion: (handshake: Handshake) => string | null
  /** A session for one connection; the handshake is there for decoders that need its values. */
  start: (handshake?: Handshake) => DecoderSession
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** JSON text, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

/** Arguments as one payload: the argument itself when there is one, the list otherwise. */
export function argumentsPayload(args: readonly unknown[]): unknown {
  if (args.length === 0)
    return undefined
  return args.length === 1
    ? args[0]
    : [...args]
}

/** A message with the usual defaults: no name separator, not binary, no protocol secrets. */
export function message(init: Omit<DecodedMessage, 'separator' | 'binary' | 'wireKeys' | 'secrets'> & Partial<Pick<DecodedMessage, 'separator' | 'binary' | 'wireKeys' | 'secrets'>>): DecodedMessage {
  return {
    separator: '',
    binary: false,
    wireKeys: [],
    secrets: [],
    ...init,
  }
}
