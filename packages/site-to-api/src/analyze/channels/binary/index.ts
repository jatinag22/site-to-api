/** Binary WebSocket frames read as MessagePack or protobuf wire format (decision 0038). */
import { decodeMessagePack } from './msgpack'
import { decodeProtobuf } from './protobuf'

/** A binary frame's content, when one of the readers understood all of it. */
export interface DecodedBinary {
  encoding: 'msgpack' | 'protobuf'
  value: unknown
}

/** Base64 (as the capture stores binary frames) to bytes; null when it is not base64. */
export function base64Bytes(data: string): Uint8Array | null {
  if (!/^[\d+/A-Z]*={0,2}$/i.test(data) || data.length % 4 !== 0)
    return null
  // The text comes from the site (an Engine.IO `b` packet); a decoding error is not a build error.
  let binary: string
  try {
    binary = atob(data)
  }
  catch {
    return null
  }
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

/**
 * MessagePack first (it is self-describing, so a clean decode is strong evidence), then the
 * protobuf wire format; null when neither reads the whole frame.
 */
export function decodeBinaryFrame(data: string): DecodedBinary | null {
  const bytes = base64Bytes(data)
  if (bytes === null)
    return null
  const msgpack = decodeMessagePack(bytes)
  if (msgpack !== undefined)
    return { encoding: 'msgpack', value: msgpack }
  const protobuf = decodeProtobuf(bytes)
  return protobuf === undefined
    ? null
    : { encoding: 'protobuf', value: protobuf }
}
