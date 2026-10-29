import { describe, expect, it } from 'vitest'
import { decodeProtobuf } from './protobuf'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
function utf8(text: string): number[] {
  return [
    ...new TextEncoder().encode(text),
  ]
}

describe('decodeProtobuf', () => {
  it('names fields by number and wire type, never by a guessed name', () => {
    // field 1 varint 150, field 2 string "hi", field 3 nested { field 1 varint 1 }, field 4 fixed32 1
    const frame = bytes(0x08, 0x96, 0x01, 0x12, 0x02, ...utf8('hi'), 0x1A, 0x02, 0x08, 0x01, 0x25, 0x01, 0, 0, 0)
    expect(decodeProtobuf(frame)).toEqual({
      'field 1 (varint)': 150,
      'field 2 (string)': 'hi',
      'field 3 (message)': { 'field 1 (varint)': 1 },
      'field 4 (fixed32)': 1,
    })
  })

  it('collects repeated fields and keeps unreadable bytes as a size', () => {
    const frame = bytes(0x08, 0x01, 0x08, 0x02, 0x12, 0x02, 0xFF, 0xFE, 0x19, 1, 0, 0, 0, 0, 0, 0, 0)
    expect(decodeProtobuf(frame)).toEqual({
      'field 1 (varint)': [1, 2],
      'field 2 (bytes)': '<2 bytes>',
      'field 3 (fixed64)': 1,
    })
  })

  it('rejects one field number with two wire types', () => {
    expect(decodeProtobuf(bytes(0x08, 0x01, 0x09, 1, 0, 0, 0, 0, 0, 0, 0))).toBeUndefined()
  })

  it('rejects frames that do not parse fully and plausibly', () => {
    // one byte; a length past the end; wire type 3 (groups); field number 0; trailing tag
    expect(decodeProtobuf(bytes(0x08))).toBeUndefined()
    expect(decodeProtobuf(bytes(0x12, 0x05, 0x61))).toBeUndefined()
    expect(decodeProtobuf(bytes(0x0B, 0x00))).toBeUndefined()
    expect(decodeProtobuf(bytes(0x00, 0x01))).toBeUndefined()
    expect(decodeProtobuf(bytes(0x08, 0x01, 0x10))).toBeUndefined()
    // a field number in the reserved range 19000-19999
    expect(decodeProtobuf(bytes(0xC0, 0xB8, 0x09, 0x01))).toBeUndefined()
  })

  it('rejects text that happens to be bytes', () => {
    expect(decodeProtobuf(new TextEncoder().encode('{"type":"tick"}'))).toBeUndefined()
  })
})
