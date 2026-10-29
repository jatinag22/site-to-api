/** Hand-made frames for the decoder tests: `>` is sent by the client, `<` by the server. */
import type { ProtocolDecoder, RawFrame } from './types'

export function rawFrames(frames: Array<[direction: '>' | '<', data: string]>): RawFrame[] {
  return frames.map(([direction, data]) => ({
    direction: direction === '>'
      ? 'sent'
      : 'received',
    data,
    binary: false,
  }))
}

/** Each frame's messages as `frame name` (name parts joined), or null when not understood. */
export function readAll(decoder: ProtocolDecoder, frames: readonly RawFrame[]): Array<string[] | null> {
  const session = decoder.start()
  return frames.map(frame => session.read(frame)?.map(decoded => `${decoded.frame} ${decoded.name.join(decoded.separator)}`) ?? null)
}
