/**
 * A strict reader of SmartFoxServer 2X binary packets (decision 0048), written from the
 * published client API (`sfs2x-api`, its `PacketHeader`, `ProtocolCodec` and
 * `SFSDataSerializer`). A packet is a header byte (bit 7 binary, 6 encrypted, 5 compressed,
 * 4 blue-boxed, 3 big-sized), a 2-byte length (4 bytes when big-sized), then an SFSObject,
 * zlib-compressed when the compressed bit is set. The object is the envelope `{c, a, p}`:
 * controller (BYTE), action (SHORT) and params (SFS_OBJECT).
 *
 * The frame comes from the site, so everything is bounded: nesting depth, every declared length
 * against the bytes left, the inflated size (a zip bomb stops at {@link MAX_INFLATED_BYTES}) and
 * the number of values. A frame is accepted only when it decodes completely.
 */
import { inflateSync } from 'node:zlib'

/** Nesting deeper than this is not a message a site sends; it stops runaway input. */
const MAX_DEPTH = 32
/** More inflated bytes than this is not a game message; inflating stops there. */
export const MAX_INFLATED_BYTES = 2 * 1024 * 1024
/** Values in one packet, counting every array item and object entry. */
const MAX_VALUES = 100_000
/** The client API rejects longer object keys. */
const MAX_KEY_LENGTH = 255

const FLAG_BINARY = 0x80
const FLAG_ENCRYPTED = 0x40
const FLAG_COMPRESSED = 0x20
const FLAG_BIG_SIZED = 0x08
/** Bits no client sets. */
const FLAG_UNUSED = 0x07

/** SFSDataType ids. 19 (CLASS) is Java serialisation that the JavaScript client never reads. */
const TYPE = {
  NULL: 0,
  BOOL: 1,
  BYTE: 2,
  SHORT: 3,
  INT: 4,
  LONG: 5,
  FLOAT: 6,
  DOUBLE: 7,
  UTF_STRING: 8,
  BOOL_ARRAY: 9,
  BYTE_ARRAY: 10,
  SHORT_ARRAY: 11,
  INT_ARRAY: 12,
  LONG_ARRAY: 13,
  FLOAT_ARRAY: 14,
  DOUBLE_ARRAY: 15,
  UTF_STRING_ARRAY: 16,
  SFS_ARRAY: 17,
  SFS_OBJECT: 18,
  TEXT: 20,
} as const

class Invalid extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true })

class Reader {
  offset = 0
  values = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  need(count: number): void {
    if (count < 0 || count > this.remaining)
      throw new Invalid()
  }

  /** Counts values against {@link MAX_VALUES}. */
  count(values: number): void {
    this.values += values
    if (this.values > MAX_VALUES)
      throw new Invalid()
  }

  u8(): number {
    this.need(1)
    return this.view.getUint8(this.offset++)
  }

  u16(): number {
    this.need(2)
    const value = this.view.getUint16(this.offset)
    this.offset += 2
    return value
  }

  i16(): number {
    this.need(2)
    const value = this.view.getInt16(this.offset)
    this.offset += 2
    return value
  }

  u32(): number {
    this.need(4)
    const value = this.view.getUint32(this.offset)
    this.offset += 4
    return value
  }

  i32(): number {
    this.need(4)
    const value = this.view.getInt32(this.offset)
    this.offset += 4
    return value
  }

  i64(): number | string {
    this.need(8)
    const value = this.view.getBigInt64(this.offset)
    this.offset += 8
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }

  f32(): number | string {
    this.need(4)
    const value = this.view.getFloat32(this.offset)
    this.offset += 4
    return finite(value)
  }

  f64(): number | string {
    this.need(8)
    const value = this.view.getFloat64(this.offset)
    this.offset += 8
    return finite(value)
  }

  take(count: number): Uint8Array {
    this.need(count)
    const slice = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return slice
  }
}

/** JSON has no NaN or infinity; they are written as their names. */
function finite(value: number): number | string {
  return Number.isFinite(value)
    ? value
    : String(value)
}

function text(reader: Reader, length: number): string {
  if (length < 0)
    throw new Invalid()
  try {
    return utf8.decode(reader.take(length))
  }
  catch (error) {
    if (error instanceof Invalid)
      throw error
    throw new Invalid()
  }
}

function bool(reader: Reader): boolean {
  const byte = reader.u8()
  if (byte > 1)
    throw new Invalid()
  return byte === 1
}

/** A typed array: a 2-byte count, then `count` items of at least `size` bytes each. */
function typedArray<T>(reader: Reader, size: number, item: () => T): T[] {
  const count = reader.u16()
  reader.need(count * size)
  reader.count(count)
  const items: T[] = []
  for (let i = 0; i < count; i++)
    items.push(item())
  return items
}

/** One typed value: its type id and its JSON form. */
interface Typed {
  type: number
  value: unknown
}

function sfsArray(reader: Reader, depth: number): unknown[] {
  const count = reader.i16()
  // Every element takes at least its type byte, so a count beyond the rest of the frame is a lie.
  reader.need(count)
  reader.count(count)
  const items: unknown[] = []
  for (let i = 0; i < count; i++)
    items.push(typedValue(reader, depth + 1).value)
  return items
}

function sfsObject(reader: Reader, depth: number): Map<string, Typed> {
  const count = reader.u16()
  // Each entry is a 2-byte key length and a type byte at least.
  reader.need(count * 3)
  reader.count(count)
  const entries = new Map<string, Typed>()
  for (let i = 0; i < count; i++) {
    const length = reader.u16()
    if (length > MAX_KEY_LENGTH)
      throw new Invalid()
    const key = text(reader, length)
    if (entries.has(key))
      throw new Invalid()
    entries.set(key, typedValue(reader, depth + 1))
  }
  return entries
}

/** An object's entries as JSON. No prototype: a `__proto__` key from the site is a plain key. */
function jsonObject(entries: ReadonlyMap<string, Typed>): Record<string, unknown> {
  const object = Object.create(null) as Record<string, unknown>
  for (const [key, entry] of entries)
    object[key] = entry.value
  return object
}

function typedValue(reader: Reader, depth: number): Typed {
  if (depth > MAX_DEPTH)
    throw new Invalid()
  reader.count(1)
  const type = reader.u8()
  return {
    type,
    value: valueOf(reader, type, depth),
  }
}

function valueOf(reader: Reader, type: number, depth: number): unknown {
  switch (type) {
    case TYPE.NULL:
      return null
    case TYPE.BOOL:
      return bool(reader)
    case TYPE.BYTE:
      return reader.u8()
    case TYPE.SHORT:
      return reader.i16()
    case TYPE.INT:
      return reader.i32()
    case TYPE.LONG:
      return reader.i64()
    case TYPE.FLOAT:
      return reader.f32()
    case TYPE.DOUBLE:
      return reader.f64()
    case TYPE.UTF_STRING:
      return text(reader, reader.i16())
    case TYPE.TEXT:
      return text(reader, reader.i32())
    case TYPE.BOOL_ARRAY:
      return typedArray(reader, 1, () => bool(reader))
    case TYPE.BYTE_ARRAY: {
      // Raw bytes have no JSON form; their size is what a reader can use.
      const length = reader.i32()
      reader.take(length)
      return `<${length} bytes>`
    }
    case TYPE.SHORT_ARRAY:
      return typedArray(reader, 2, () => reader.i16())
    case TYPE.INT_ARRAY:
      return typedArray(reader, 4, () => reader.i32())
    case TYPE.LONG_ARRAY:
      return typedArray(reader, 8, () => reader.i64())
    case TYPE.FLOAT_ARRAY:
      return typedArray(reader, 4, () => reader.f32())
    case TYPE.DOUBLE_ARRAY:
      return typedArray(reader, 8, () => reader.f64())
    case TYPE.UTF_STRING_ARRAY:
      return typedArray(reader, 2, () => text(reader, reader.i16()))
    case TYPE.SFS_ARRAY:
      return sfsArray(reader, depth)
    case TYPE.SFS_OBJECT:
      return jsonObject(sfsObject(reader, depth))
    default:
      throw new Invalid()
  }
}

/** A packet as read: an encrypted one (never decoded), or the envelope of a decoded one. */
export type Sfs2xPacket
  = | { kind: 'encrypted', compressed: boolean, length: number }
    | {
      kind: 'message'
      compressed: boolean
      /** Controller id `c`: 0 system, 1 extension. */
      controller: number
      /** Action id `a`: the request or event id within the controller. */
      action: number
      /** Params `p`; an empty object when the packet has none. */
      params: Record<string, unknown>
    }

/** Adler-32, the checksum that ends a zlib stream. */
function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/**
 * zlib data inflated to at most {@link MAX_INFLATED_BYTES}, else null. Node ignores bytes after
 * the end of the stream, so the stream must end the packet: its last four bytes are the
 * Adler-32 of what it inflated to.
 */
function inflated(data: Uint8Array): Uint8Array | null {
  let output: Uint8Array
  try {
    output = inflateSync(data, { maxOutputLength: MAX_INFLATED_BYTES })
  }
  catch {
    // Not zlib, truncated, or over the size limit (a RangeError): not a packet we read.
    return null
  }
  if (data.length < 4)
    return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return view.getUint32(data.length - 4) === adler32(output)
    ? output
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The envelope `{c: BYTE, a: SHORT, p?: SFS_OBJECT}` of a decoded object, or null. */
function envelope(entries: ReadonlyMap<string, Typed>, compressed: boolean): Sfs2xPacket | null {
  const controller = entries.get('c')
  const action = entries.get('a')
  const params = entries.get('p')
  const known = Number(controller !== undefined) + Number(action !== undefined) + Number(params !== undefined)
  if (known !== entries.size || controller?.type !== TYPE.BYTE || action?.type !== TYPE.SHORT)
    return null
  if (params !== undefined && params.type !== TYPE.SFS_OBJECT)
    return null
  if (typeof controller.value !== 'number' || typeof action.value !== 'number')
    return null
  const value = params?.value
  return {
    kind: 'message',
    compressed,
    controller: controller.value,
    action: action.value,
    params: isRecord(value)
      ? value
      : Object.create(null) as Record<string, unknown>,
  }
}

/**
 * The frame as one SFS2X packet, or null when it is not exactly one: the header's length must
 * cover the rest of the frame, and the (inflated) SFSObject must decode to its last byte as the
 * `{c, a, p}` envelope. An encrypted packet is only recognised by its header and length.
 */
export function decodeSfs2xPacket(bytes: Uint8Array): Sfs2xPacket | null {
  const flags = bytes[0]
  if (flags === undefined || (flags & FLAG_BINARY) === 0 || (flags & FLAG_UNUSED) !== 0)
    return null
  const header = new Reader(bytes)
  let payload: Uint8Array
  try {
    header.u8()
    const length = (flags & FLAG_BIG_SIZED) === 0
      ? header.u16()
      : header.u32()
    if (length === 0 || length !== header.remaining)
      return null
    payload = header.take(length)
  }
  catch (error) {
    if (error instanceof Invalid)
      return null
    throw error
  }
  const compressed = (flags & FLAG_COMPRESSED) !== 0
  if ((flags & FLAG_ENCRYPTED) !== 0)
    return { kind: 'encrypted', compressed, length: payload.length }
  // The blue-boxed bit (0x10) only says how the packet travelled; the object is the same.
  const object = compressed
    ? inflated(payload)
    : payload
  if (object === null)
    return null
  const reader = new Reader(object)
  try {
    if (reader.u8() !== TYPE.SFS_OBJECT)
      return null
    const entries = sfsObject(reader, 0)
    return reader.remaining === 0
      ? envelope(entries, compressed)
      : null
  }
  catch (error) {
    if (error instanceof Invalid)
      return null
    throw error
  }
}
