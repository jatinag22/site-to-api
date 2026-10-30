/**
 * Framing protocols over WebSocket (decision 0038): which one a connection speaks, detected from
 * its URL, its subprotocol and its frames, and each frame read as protocol messages. Detection is
 * deterministic: the same frames always give the same answer.
 */
import type { ChannelProtocol } from '../../../model'
import type { DecodedMessage, Handshake, ProtocolDecoder, RawFrame } from './types'
import { centrifugo } from './centrifugo'
import { firebase } from './firebase'
import { graphqlWs } from './graphql-ws'
import { phoenix } from './phoenix'
import { primus } from './primus'
import { sfs2x } from './sfs2x'
import { signalr } from './signalr'
import { socketIo } from './socketio'
import { unwrapSockjs } from './sockjs'
import { sse } from './sse'
import { stomp } from './stomp'

export { safeName } from './names'
export { pollingPackets } from './socketio'
export { eventWire, parseEventStream } from './sse'
export type { DecodedMessage, Handshake, RawFrame } from './types'

/** In this order on a tie, so detection never depends on anything but the frames. */
const DECODERS: readonly ProtocolDecoder[] = [
  socketIo,
  signalr,
  stomp,
  graphqlWs,
  phoenix,
  centrifugo,
  sfs2x,
  firebase,
  primus,
]

/**
 * Without a hint from the URL or subprotocol, this share of the frames the protocol travels in
 * (text frames, or binary frames for SFS2X) must decode.
 */
const MIN_CONTENT_SHARE = 0.8
/** With a hint, a smaller share is enough: the hint already names the protocol. */
const MIN_HINTED_SHARE = 0.5

/** One record of a captured frame: what was sent, and its protocol reading when there is one. */
export interface FrameRecord {
  data: string
  binary: boolean
  decoded: DecodedMessage | null
}

/** A connection read with its protocol: the protocol (null if none) and each frame's records. */
export interface DecodedConnection {
  protocol: ChannelProtocol | null
  /** Per captured frame, in order, the records it holds (one, unless the protocol batches). */
  frames: FrameRecord[][]
}

interface Attempt {
  decoder: ProtocolDecoder
  hint: string | null
  readings: Array<DecodedMessage[] | null>
  /** Frames of the decoder's content kind that it understood. */
  understood: number
  /** Frames of the decoder's content kind. */
  carriers: number
  strong: boolean
  version: string | null
}

function attempt(decoder: ProtocolDecoder, frames: readonly RawFrame[], handshake: Handshake): Attempt {
  const session = decoder.start(handshake)
  const readings = frames.map(frame => session.read(frame))
  const carries = (frame: RawFrame | undefined): boolean => frame?.binary === (decoder.content === 'binary')
  return {
    decoder,
    hint: decoder.hint(handshake),
    readings,
    understood: readings.filter((reading, index) => reading !== null && carries(frames[index])).length,
    carriers: frames.filter(frame => carries(frame)).length,
    strong: readings.some(reading => reading?.some(item => item.strong) === true),
    version: decoder.handshakeVersion(handshake) ?? session.version(),
  }
}

/**
 * Whether an attempt shows the protocol: with a hint, most of the frames it travels in decode
 * (or there are none); without, at least one message only this protocol sends and nearly every
 * such frame.
 */
function accepted(candidate: Attempt): boolean {
  const frames = candidate.carriers
  if (candidate.hint !== null)
    return frames === 0 || candidate.understood >= MIN_HINTED_SHARE * frames
  return candidate.strong && frames > 0 && candidate.understood >= MIN_CONTENT_SHARE * frames
}

function byStrength(a: Attempt, b: Attempt): number {
  return Number(b.hint !== null) - Number(a.hint !== null) || b.understood - a.understood || DECODERS.indexOf(a.decoder) - DECODERS.indexOf(b.decoder)
}

function plain(frames: readonly RawFrame[]): DecodedConnection {
  return {
    protocol: null,
    frames: frames.map(frame => [
      { data: frame.data, binary: frame.binary, decoded: null },
    ]),
  }
}

/** The best decoder for these frames, or null when none is shown. */
function detect(frames: readonly RawFrame[], handshake: Handshake): Attempt | null {
  // An event stream's frames are its events: no WebSocket protocol applies to them.
  return (handshake.eventStream === true
    ? [sse]
    : DECODERS)
    .map(decoder => attempt(decoder, frames, handshake))
    .filter(accepted)
    .sort(byStrength)[0] ?? null
}

function protocolOf(best: Attempt, wrapper: ChannelProtocol['wrapper']): ChannelProtocol {
  return {
    id: best.decoder.id,
    version: best.version,
    evidence: [
      ...(best.hint === null
        ? []
        : [best.hint]),
      ...(wrapper === 'sockjs'
        ? ['SockJS framing']
        : []),
      ...(best.understood > 0
        ? ['frames']
        : []),
    ],
    wrapper,
  }
}

function records(frame: RawFrame, reading: DecodedMessage[] | null): FrameRecord[] {
  return reading === null
    ? [
        { data: frame.data, binary: frame.binary, decoded: null },
      ]
    : reading.map(decoded => ({ data: decoded.data, binary: decoded.binary, decoded }))
}

/**
 * Reads one connection's frames with the protocol they show. Frames the protocol does not
 * understand stay as they were (plain JSON, text or binary). SockJS framing is unwrapped first.
 */
export function decodeConnection(frames: readonly RawFrame[], handshake: Handshake): DecodedConnection {
  const sockjs = handshake.eventStream === true
    ? null
    : unwrapSockjs(frames, handshake)
  if (sockjs === null) {
    const best = detect(frames, handshake)
    return best === null
      ? plain(frames)
      : {
          protocol: protocolOf(best, null),
          frames: frames.map((frame, index) => records(frame, best.readings[index] ?? null)),
        }
  }
  const inner = sockjs.flatMap(units => units.flatMap(unit => unit.frame === null
    ? []
    : [unit.frame]))
  const best = detect(inner, handshake)
  let next = 0
  return {
    protocol: best === null
      ? null
      : protocolOf(best, 'sockjs'),
    frames: sockjs.map(units => units.flatMap((unit) => {
      if (unit.frame === null) {
        return best === null
          ? [
              { data: unit.control.data, binary: false, decoded: null },
            ]
          : [
              { data: unit.control.data, binary: false, decoded: unit.control },
            ]
      }
      const reading = best?.readings[next] ?? null
      next++
      return records(unit.frame, reading)
    })),
  }
}
