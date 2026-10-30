/**
 * An SFS2X packet writer for the tests, written from the published format (decision 0048): each
 * helper returns a typed value's bytes (type id, then body), big-endian.
 */
import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'

function u16(value: number): number[] {
  return [(value >> 8) & 0xFF, value & 0xFF]
}

function u32(value: number): number[] {
  return [
    (value >>> 24) & 0xFF,
    (value >>> 16) & 0xFF,
    (value >>> 8) & 0xFF,
    value & 0xFF,
  ]
}

function bytesOf(size: 4 | 8, write: (view: DataView) => void): number[] {
  const view = new DataView(new ArrayBuffer(size))
  write(view)
  return [
    ...new Uint8Array(view.buffer),
  ]
}

function utf8(text: string): number[] {
  return [
    ...new TextEncoder().encode(text),
  ]
}

function str(text: string): number[] {
  const bytes = utf8(text)
  return [
    ...u16(bytes.length),
    ...bytes,
  ]
}

export const sfs = {
  null: (): number[] => [0],
  bool: (value: boolean): number[] => [
    1,
    value
      ? 1
      : 0,
  ],
  byte: (value: number): number[] => [2, value & 0xFF],
  short: (value: number): number[] => [
    3,
    ...u16(value & 0xFFFF),
  ],
  int: (value: number): number[] => [
    4,
    ...u32(value),
  ],
  long: (value: bigint): number[] => [
    5,
    ...bytesOf(8, view => view.setBigInt64(0, value)),
  ],
  float: (value: number): number[] => [
    6,
    ...bytesOf(4, view => view.setFloat32(0, value)),
  ],
  double: (value: number): number[] => [
    7,
    ...bytesOf(8, view => view.setFloat64(0, value)),
  ],
  string: (value: string): number[] => [
    8,
    ...str(value),
  ],
  boolArray: (values: boolean[]): number[] => [
    9,
    ...u16(values.length),
    ...values.map(value => value
      ? 1
      : 0),
  ],
  byteArray: (values: number[]): number[] => [
    10,
    ...u32(values.length),
    ...values,
  ],
  shortArray: (values: number[]): number[] => [
    11,
    ...u16(values.length),
    ...values.flatMap(value => u16(value & 0xFFFF)),
  ],
  intArray: (values: number[]): number[] => [
    12,
    ...u16(values.length),
    ...values.flatMap(u32),
  ],
  longArray: (values: bigint[]): number[] => [
    13,
    ...u16(values.length),
    ...values.flatMap(value => bytesOf(8, view => view.setBigInt64(0, value))),
  ],
  floatArray: (values: number[]): number[] => [
    14,
    ...u16(values.length),
    ...values.flatMap(value => bytesOf(4, view => view.setFloat32(0, value))),
  ],
  doubleArray: (values: number[]): number[] => [
    15,
    ...u16(values.length),
    ...values.flatMap(value => bytesOf(8, view => view.setFloat64(0, value))),
  ],
  stringArray: (values: string[]): number[] => [
    16,
    ...u16(values.length),
    ...values.flatMap(str),
  ],
  array: (items: number[][]): number[] => [
    17,
    ...u16(items.length),
    ...items.flat(),
  ],
  object: (entries: Record<string, number[]>): number[] => [
    18,
    ...u16(Object.keys(entries).length),
    ...Object.entries(entries).flatMap(([key, value]) => [
      ...str(key),
      ...value,
    ]),
  ],
  text: (value: string): number[] => {
    const bytes = utf8(value)
    return [
      20,
      ...u32(bytes.length),
      ...bytes,
    ]
  },
}

export interface PacketOptions {
  /** zlib-compress the object and set the compressed bit. */
  compress?: boolean
  /** Bits to add to the header byte (0x40 encrypted, 0x10 blue-boxed). */
  flags?: number
  /** Write a 4-byte length and set the big-sized bit. */
  big?: boolean
}

/** A whole packet around an already encoded SFSObject. */
export function rawPacket(object: number[] | Uint8Array, options: PacketOptions = {}): Uint8Array {
  const body = options.compress === true
    ? [
        ...deflateSync(Uint8Array.from(object)),
      ]
    : [
        ...object,
      ]
  const flags = 0x80 | (options.flags ?? 0) | (options.compress === true
    ? 0x20
    : 0) | (options.big === true
    ? 0x08
    : 0)
  return Uint8Array.from([
    flags,
    ...(options.big === true
      ? u32(body.length)
      : u16(body.length)),
    ...body,
  ])
}

/** The packet `{c: controller, a: action, p: params}`. */
export function packet(controller: number, action: number, params: Record<string, number[]>, options: PacketOptions = {}): Uint8Array {
  return rawPacket(sfs.object({
    c: sfs.byte(controller),
    a: sfs.short(action),
    p: sfs.object(params),
  }), options)
}

/** An extension message: `{c: 1, a: 13, p: {c: command, p: params}}`. */
export function extensionPacket(command: string, params: Record<string, number[]>, options: PacketOptions = {}): Uint8Array {
  return packet(1, 13, {
    c: sfs.string(command),
    p: sfs.object(params),
  }, options)
}

/** Bytes as the capture stores a binary frame. */
export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
