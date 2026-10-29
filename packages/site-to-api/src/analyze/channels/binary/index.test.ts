import { describe, expect, it } from 'vitest'
import { base64Bytes, decodeBinaryFrame } from './index'

const base64 = (...values: number[]): string => btoa(String.fromCharCode(...values))

describe('decodeBinaryFrame', () => {
  it('tries MessagePack first, then protobuf, then gives up', () => {
    expect(decodeBinaryFrame(base64(0x81, 0xA1, 0x61, 0x01))).toEqual({
      encoding: 'msgpack',
      value: { a: 1 },
    })
    expect(decodeBinaryFrame(base64(0x08, 0x2A))).toEqual({
      encoding: 'protobuf',
      value: { 'field 1 (varint)': 42 },
    })
    expect(decodeBinaryFrame(base64(0x7B, 0x7D))).toBeNull()
    expect(decodeBinaryFrame('not base64!')).toBeNull()
  })

  it('reads base64 strictly', () => {
    expect(base64Bytes('AQI=')).toEqual(Uint8Array.from([1, 2]))
    expect(base64Bytes('A')).toBeNull()
  })
})
