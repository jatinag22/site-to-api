import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeSfs2xPacket, MAX_INFLATED_BYTES } from './sfs2x'
import { extensionPacket, packet, rawPacket, sfs } from './sfs2x-test-packets'

function paramsOf(bytes: Uint8Array): unknown {
  const decoded = decodeSfs2xPacket(bytes)
  return decoded?.kind === 'message'
    ? decoded.params
    : decoded
}

describe('decodeSfs2xPacket', () => {
  it('reads the envelope of a system message', () => {
    expect(decodeSfs2xPacket(packet(0, 0, {
      api: sfs.string('1.8.4'),
      cl: sfs.string('JavaScript'),
    }))).toEqual({
      kind: 'message',
      compressed: false,
      controller: 0,
      action: 0,
      params: { api: '1.8.4', cl: 'JavaScript' },
    })
  })

  it('reads every SFSDataType', () => {
    const params = paramsOf(packet(0, 7, {
      nul: sfs.null(),
      yes: sfs.bool(true),
      no: sfs.bool(false),
      byte: sfs.byte(200),
      short: sfs.short(-2),
      int: sfs.int(-70_000),
      long: sfs.long(1_700_000_000_000n),
      huge: sfs.long(9_007_199_254_740_993n),
      float: sfs.float(1.5),
      double: sfs.double(2.25),
      nan: sfs.double(Number.NaN),
      str: sfs.string('héllo'),
      text: sfs.text('long text'),
      bools: sfs.boolArray([true, false]),
      bytes: sfs.byteArray([1, 2, 3]),
      shorts: sfs.shortArray([1, -1]),
      ints: sfs.intArray([7, -7]),
      longs: sfs.longArray([5n, -5n]),
      floats: sfs.floatArray([0.5]),
      doubles: sfs.doubleArray([0.25]),
      strs: sfs.stringArray(['a', 'b']),
      list: sfs.array([
        sfs.int(1),
        sfs.string('two'),
        sfs.object({
          three: sfs.bool(true),
        }),
      ]),
      nested: sfs.object({
        inner: sfs.array([]),
      }),
    }))
    expect(params).toEqual({
      nul: null,
      yes: true,
      no: false,
      byte: 200,
      short: -2,
      int: -70_000,
      long: 1_700_000_000_000,
      huge: '9007199254740993',
      float: 1.5,
      double: 2.25,
      nan: 'NaN',
      str: 'héllo',
      text: 'long text',
      bools: [true, false],
      bytes: '<3 bytes>',
      shorts: [1, -1],
      ints: [7, -7],
      longs: [5, -5],
      floats: [0.5],
      doubles: [0.25],
      strs: ['a', 'b'],
      list: [
        1,
        'two',
        { three: true },
      ],
      nested: { inner: [] },
    })
  })

  it('reads compressed, big-sized and blue-boxed packets', () => {
    const params = {
      c: sfs.string('x'),
      p: sfs.object({
        x: sfs.double(1.37),
      }),
    }
    const compressed = decodeSfs2xPacket(packet(1, 13, params, { compress: true }))
    expect(compressed).toMatchObject({
      kind: 'message',
      compressed: true,
      controller: 1,
      params: {
        c: 'x',
        p: { x: 1.37 },
      },
    })
    expect(decodeSfs2xPacket(packet(1, 13, params, { big: true }))).toMatchObject({
      kind: 'message',
      params: { c: 'x' },
    })
    expect(decodeSfs2xPacket(packet(1, 13, params, { flags: 0x10 }))).toMatchObject({
      kind: 'message',
      params: { c: 'x' },
    })
  })

  it('reads an extension response', () => {
    expect(paramsOf(extensionPacket('updateCurrentCashOuts', {
      openBetsCount: sfs.int(3),
      code: sfs.int(200),
    }))).toEqual({
      c: 'updateCurrentCashOuts',
      p: { openBetsCount: 3, code: 200 },
    })
  })

  it('keeps a __proto__ key as a plain key', () => {
    // A computed key: `{ __proto__: … }` would set the literal's prototype instead.
    const decoded = decodeSfs2xPacket(packet(0, 7, {
      ['__proto__']: sfs.string('x'),
    }))
    expect(decoded?.kind).toBe('message')
    if (decoded?.kind !== 'message')
      return
    expect(Object.getPrototypeOf(decoded.params)).toBeNull()
    expect(Object.hasOwn(decoded.params, '__proto__')).toBe(true)
  })

  it('recognises an encrypted packet by its header without decoding it', () => {
    expect(decodeSfs2xPacket(rawPacket([1, 2, 3, 4, 5], { flags: 0x40 }))).toEqual({ kind: 'encrypted', compressed: false, length: 5 })
  })

  describe('rejects', () => {
    const valid = packet(0, 29, {})

    it('frames that are not one whole packet', () => {
      expect(decodeSfs2xPacket(new Uint8Array())).toBeNull()
      expect(decodeSfs2xPacket(Uint8Array.from([0x80]))).toBeNull()
      // Text-protocol header bit missing, unused header bits set.
      expect(decodeSfs2xPacket(Uint8Array.from([
        0x00,
        ...valid.subarray(1),
      ]))).toBeNull()
      expect(decodeSfs2xPacket(Uint8Array.from([
        0x81,
        ...valid.subarray(1),
      ]))).toBeNull()
      // Truncated, and with a trailing byte.
      expect(decodeSfs2xPacket(valid.subarray(0, valid.length - 1))).toBeNull()
      expect(decodeSfs2xPacket(Uint8Array.from([...valid, 0]))).toBeNull()
      expect(decodeSfs2xPacket(rawPacket([]))).toBeNull()
    })

    it('objects that are not the {c, a, p} envelope', () => {
      expect(decodeSfs2xPacket(rawPacket(sfs.object({
        c: sfs.byte(0),
      })))).toBeNull()
      expect(decodeSfs2xPacket(rawPacket(sfs.object({
        c: sfs.int(0),
        a: sfs.short(0),
      })))).toBeNull()
      expect(decodeSfs2xPacket(rawPacket(sfs.object({
        c: sfs.byte(0),
        a: sfs.short(0),
        p: sfs.string('x'),
      })))).toBeNull()
      expect(decodeSfs2xPacket(rawPacket(sfs.object({
        c: sfs.byte(0),
        a: sfs.short(0),
        extra: sfs.null(),
      })))).toBeNull()
      expect(decodeSfs2xPacket(rawPacket(sfs.array([
        sfs.byte(0),
      ])))).toBeNull()
      // Accepted without params: an empty object stands in.
      expect(paramsOf(rawPacket(sfs.object({
        c: sfs.byte(0),
        a: sfs.short(29),
      })))).toEqual({})
    })

    it('invalid values: unknown type, bad bool, bad UTF-8, duplicate keys, overlong key', () => {
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [19, 0],
      }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [1, 2],
      }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [8, 0, 1, 0xFF],
      }))).toBeNull()
      const duplicate = [
        18,
        0,
        2,
        0,
        1,
        0x6B,
        ...sfs.null(),
        0,
        1,
        0x6B,
        ...sfs.null(),
      ]
      expect(decodeSfs2xPacket(packet(0, 7, { v: duplicate }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        ['k'.repeat(256)]: sfs.null(),
      }))).toBeNull()
    })

    it('a length bomb: declared lengths and counts beyond the frame', () => {
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [8, 0x7F, 0xFF, 0x61],
      }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [20, 0x7F, 0xFF, 0xFF, 0xFF],
      }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [10, 0x7F, 0xFF, 0xFF, 0xFF],
      }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [12, 0xFF, 0xFF, 0, 0, 0, 1],
      }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [17, 0x7F, 0xFF, 0],
      }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [18, 0xFF, 0xFF],
      }))).toBeNull()
      // Negative sizes.
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [8, 0xFF, 0xFF],
      }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, {
        v: [17, 0xFF, 0xFF],
      }))).toBeNull()
      // The header's length beyond the frame.
      expect(decodeSfs2xPacket(Uint8Array.from([0x88, 0xFF, 0xFF, 0xFF, 0xFF, 18, 0, 0]))).toBeNull()
    })

    it('a depth bomb', () => {
      let nested = sfs.null()
      for (let i = 0; i < 40; i++)
        nested = sfs.array([nested])
      expect(decodeSfs2xPacket(packet(0, 7, { v: nested }))).toBeNull()
      let shallow = sfs.null()
      for (let i = 0; i < 20; i++)
        shallow = sfs.array([shallow])
      expect(decodeSfs2xPacket(packet(0, 7, { v: shallow }))).not.toBeNull()
    })

    it('a zlib bomb, broken zlib and zlib with trailing bytes', () => {
      // Zero bytes past the inflate limit, deflated to a few kilobytes.
      const items = MAX_INFLATED_BYTES + 10
      const bomb = Uint8Array.from([
        18,
        0,
        1,
        0,
        1,
        0x76,
        17,
        0x7F,
        0xFF,
        ...Array.from({ length: items }).fill(0),
      ])
      const compressed = deflateSync(bomb)
      expect(compressed.length).toBeLessThan(10_000)
      expect(decodeSfs2xPacket(rawPacket(compressed, { flags: 0x20 }))).toBeNull()
      expect(decodeSfs2xPacket(rawPacket([0x78, 0x9C, 1, 2, 3], { flags: 0x20 }))).toBeNull()
      const object = sfs.object({
        c: sfs.byte(0),
        a: sfs.short(29),
      })
      expect(decodeSfs2xPacket(rawPacket([
        ...deflateSync(Uint8Array.from(object)),
        0,
      ], { flags: 0x20 }))).toBeNull()
      expect(decodeSfs2xPacket(rawPacket(deflateSync(Uint8Array.from(object)), { flags: 0x20 }))).toMatchObject({ kind: 'message', compressed: true })
    })

    it('too many values in one packet', () => {
      const many = Array.from({ length: 30_000 }, () => sfs.null())
      const list = sfs.array(many)
      expect(decodeSfs2xPacket(packet(0, 7, { a: list, b: list, c: list, d: list }, { big: true }))).toBeNull()
      expect(decodeSfs2xPacket(packet(0, 7, { a: list }, { big: true }))).not.toBeNull()
    })
  })
})
