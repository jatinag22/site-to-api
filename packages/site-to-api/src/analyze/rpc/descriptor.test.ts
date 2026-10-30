import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { connectIdempotencyInText, descriptorIdempotency } from './descriptor'

function varint(value: number): number[] {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest & 0x7F) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return bytes
}

function field(number: number, value: string | number[] | number): number[] {
  if (typeof value === 'number') {
    return [
      ...varint(number * 8),
      ...varint(value),
    ]
  }
  const bytes = typeof value === 'string'
    ? [
        ...new TextEncoder().encode(value),
      ]
    : value
  return [
    ...varint(number * 8 + 2),
    ...varint(bytes.length),
    ...bytes,
  ]
}

function method(name: string, level: number | null): number[] {
  return field(2, [
    ...field(1, name),
    ...field(2, '.demo.v1.Req'),
    ...field(3, '.demo.v1.Res'),
    ...(level === null
      ? []
      : field(4, field(34, level))),
  ])
}

const FILE = Uint8Array.from([
  ...field(1, 'demo/v1/items.proto'),
  ...field(2, 'demo.v1'),
  ...field(6, [
    ...field(1, 'ItemService'),
    ...method('GetItems', 1),
    ...method('PutItem', 2),
    ...method('DeleteItem', null),
  ]),
])

describe('descriptorIdempotency', () => {
  it('reads methods marked NO_SIDE_EFFECTS and IDEMPOTENT from a file descriptor', () => {
    expect(descriptorIdempotency(FILE)).toEqual(new Map([
      ['demo.v1.ItemService/GetItems', 'no-side-effects'],
      ['demo.v1.ItemService/PutItem', 'idempotent'],
    ]))
  })

  it('rejects bytes that are not a .proto descriptor', () => {
    expect(descriptorIdempotency(Uint8Array.from(field(1, 'notes.txt')))).toBeNull()
    expect(descriptorIdempotency(FILE.subarray(0, FILE.length - 3))).toBeNull()
    expect(descriptorIdempotency(Uint8Array.from([0x0B, 1, 2]))).toBeNull()
    expect(descriptorIdempotency(Uint8Array.from([
      ...field(1, 'a.proto'),
      0x32,
      0x7F,
    ]))).toBeNull()
  })
})

describe('connectIdempotencyInText', () => {
  it('finds embedded base64 descriptors (protobuf-es v2)', () => {
    const code = `const file_demo=fd("${Buffer.from(FILE).toString('base64')}",[dep]);`
    expect(connectIdempotencyInText(code).get('demo.v1.ItemService/GetItems')).toBe('no-side-effects')
  })

  it('finds service objects (protobuf-es v1), minified or not', () => {
    const code = 'const S={typeName:"demo.v1.ItemService",methods:{getItems:{name:"GetItems",I:a,O:b,kind:k.Unary,idempotency:e.NoSideEffects},putItem:{name:"PutItem",I:a,O:b,kind:k.Unary}}};const T={typeName:"demo.v1.Other",methods:{x:{name:"X",I:a,O:b,kind:k.Unary,idempotency:e.Idempotent}}}'
    expect(connectIdempotencyInText(code)).toEqual(new Map([
      ['demo.v1.ItemService/GetItems', 'no-side-effects'],
      ['demo.v1.Other/X', 'idempotent'],
    ]))
  })

  it('ignores other base64 strings', () => {
    expect(connectIdempotencyInText(`x="${Buffer.from('Ci just some text that is long enough to look like base64').toString('base64')}"`).size).toBe(0)
  })
})
