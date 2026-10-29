import { describe, expect, it } from 'vitest'
import { decodeMessagePack } from './msgpack'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
function utf8(text: string): number[] {
  return [
    ...new TextEncoder().encode(text),
  ]
}

describe('decodeMessagePack', () => {
  it('reads a map of strings, integers, floats, booleans and nil', () => {
    // {"type":"tick","seq":300,"price":1.5,"live":true,"note":nil}
    const frame = bytes(
      0x85,
      0xA4,
      ...utf8('type'),
      0xA4,
      ...utf8('tick'),
      0xA3,
      ...utf8('seq'),
      0xCD,
      0x01,
      0x2C,
      0xA5,
      ...utf8('price'),
      0xCB,
      0x3F,
      0xF8,
      0,
      0,
      0,
      0,
      0,
      0,
      0xA4,
      ...utf8('live'),
      0xC3,
      0xA4,
      ...utf8('note'),
      0xC0,
    )
    expect(decodeMessagePack(frame)).toEqual({
      type: 'tick',
      seq: 300,
      price: 1.5,
      live: true,
      note: null,
    })
  })

  it('reads arrays, negative integers, binary strings and timestamps', () => {
    const frame = bytes(0x94, 0xFF, 0xD0, 0x80, 0xC4, 0x03, 1, 2, 3, 0xD6, 0xFF, 0x00, 0x00, 0x00, 0x3C)
    expect(decodeMessagePack(frame)).toEqual([
      -1,
      -128,
      '<3 bytes>',
      '1970-01-01T00:01:00.000Z',
    ])
  })

  it('writes integers beyond 2^53 as digits', () => {
    expect(decodeMessagePack(bytes(0x91, 0xCF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF))).toEqual(['18446744073709551615'])
  })

  it('rejects scalars, leftovers, truncation, reserved bytes, bad UTF-8 and duplicate keys', () => {
    expect(decodeMessagePack(bytes(0x05))).toBeUndefined()
    expect(decodeMessagePack(bytes(0x90, 0x00))).toBeUndefined()
    expect(decodeMessagePack(bytes(0x92, 0x01))).toBeUndefined()
    expect(decodeMessagePack(bytes(0x91, 0xC1))).toBeUndefined()
    expect(decodeMessagePack(bytes(0x91, 0xA2, 0xC3, 0x28))).toBeUndefined()
    expect(decodeMessagePack(bytes(0x82, 0xA1, 0x61, 0x01, 0xA1, 0x61, 0x02))).toBeUndefined()
    expect(decodeMessagePack(bytes(0xDC, 0xFF, 0xFF))).toBeUndefined()
    expect(decodeMessagePack(new Uint8Array())).toBeUndefined()
  })

  it('does not take JSON text for MessagePack', () => {
    expect(decodeMessagePack(new TextEncoder().encode('{"a":1}'))).toBeUndefined()
  })
})
