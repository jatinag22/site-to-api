/**
 * A strict MessagePack reader (the format is self-describing, so no schema is needed). It turns a
 * frame into a JSON value only when the whole frame is exactly one map or array that decodes
 * cleanly: every byte consumed, valid UTF-8, no reserved type byte, no duplicate keys. Almost any
 * byte decodes as some MessagePack scalar, so anything less is left as opaque binary
 * (decision 0038).
 */

/** Nesting deeper than this is not a message a site sends; it stops runaway input. */
const MAX_DEPTH = 32

class Invalid extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true })

class Reader {
  offset = 0
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

  u32(): number {
    this.need(4)
    const value = this.view.getUint32(this.offset)
    this.offset += 4
    return value
  }

  take(count: number): Uint8Array {
    this.need(count)
    const slice = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return slice
  }

  float(size: 4 | 8): number {
    this.need(size)
    const value = size === 4
      ? this.view.getFloat32(this.offset)
      : this.view.getFloat64(this.offset)
    this.offset += size
    return value
  }

  bigInt(signed: boolean): bigint {
    this.need(8)
    const value = signed
      ? this.view.getBigInt64(this.offset)
      : this.view.getBigUint64(this.offset)
    this.offset += 8
    return value
  }

  int(size: 1 | 2 | 4): number {
    this.need(size)
    const value = size === 1
      ? this.view.getInt8(this.offset)
      : size === 2
        ? this.view.getInt16(this.offset)
        : this.view.getInt32(this.offset)
    this.offset += size
    return value
  }
}

/** A 64-bit integer as a number when it fits, otherwise its decimal digits. */
function fromBigInt(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value.toString()
}

function text(reader: Reader, length: number): string {
  try {
    return utf8.decode(reader.take(length))
  }
  catch {
    throw new Invalid()
  }
}

/** Raw bytes have no JSON form; their size is what a reader can use. */
function binary(reader: Reader, length: number): string {
  reader.take(length)
  return `<${length} bytes>`
}

/** The timestamp extension (-1) as an ISO date; other extensions by type and size. */
function extension(reader: Reader, length: number): string {
  const type = reader.int(1)
  const data = reader.take(length)
  if (type === -1 && (length === 4 || length === 8)) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const seconds = length === 4
      ? view.getUint32(0)
      : Number(view.getBigUint64(0) & 0x3_FFFF_FFFFn)
    const date = new Date(seconds * 1000)
    if (!Number.isNaN(date.getTime()))
      return date.toISOString()
  }
  return `<extension ${type}, ${length} bytes>`
}

function array(reader: Reader, count: number, depth: number): unknown[] {
  // Every element takes at least one byte, so a count beyond the rest of the frame is a lie.
  reader.need(count)
  const items: unknown[] = []
  for (let i = 0; i < count; i++)
    items.push(value(reader, depth + 1))
  return items
}

function map(reader: Reader, count: number, depth: number): Record<string, unknown> {
  reader.need(count * 2)
  const entries: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const key = value(reader, depth + 1)
    if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'boolean')
      throw new Invalid()
    const name = String(key)
    if (Object.hasOwn(entries, name))
      throw new Invalid()
    entries[name] = value(reader, depth + 1)
  }
  return entries
}

/** Readers for the type bytes 0xC0-0xDF, which name their type and size in the byte itself. */
const FIXED: Record<number, (reader: Reader, depth: number) => unknown> = {
  0xC0: () => null,
  0xC2: () => false,
  0xC3: () => true,
  0xC4: reader => binary(reader, reader.u8()),
  0xC5: reader => binary(reader, reader.u16()),
  0xC6: reader => binary(reader, reader.u32()),
  0xC7: reader => extension(reader, reader.u8()),
  0xC8: reader => extension(reader, reader.u16()),
  0xC9: reader => extension(reader, reader.u32()),
  0xCA: reader => reader.float(4),
  0xCB: reader => reader.float(8),
  0xCC: reader => reader.u8(),
  0xCD: reader => reader.u16(),
  0xCE: reader => reader.u32(),
  0xCF: reader => fromBigInt(reader.bigInt(false)),
  0xD0: reader => reader.int(1),
  0xD1: reader => reader.int(2),
  0xD2: reader => reader.int(4),
  0xD3: reader => fromBigInt(reader.bigInt(true)),
  0xD4: reader => extension(reader, 1),
  0xD5: reader => extension(reader, 2),
  0xD6: reader => extension(reader, 4),
  0xD7: reader => extension(reader, 8),
  0xD8: reader => extension(reader, 16),
  0xD9: reader => text(reader, reader.u8()),
  0xDA: reader => text(reader, reader.u16()),
  0xDB: reader => text(reader, reader.u32()),
  0xDC: (reader, depth) => array(reader, reader.u16(), depth),
  0xDD: (reader, depth) => array(reader, reader.u32(), depth),
  0xDE: (reader, depth) => map(reader, reader.u16(), depth),
  0xDF: (reader, depth) => map(reader, reader.u32(), depth),
}

function value(reader: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH)
    throw new Invalid()
  const byte = reader.u8()
  if (byte <= 0x7F)
    return byte
  if (byte >= 0xE0)
    return byte - 0x100
  if (byte <= 0x8F)
    return map(reader, byte & 0x0F, depth)
  if (byte <= 0x9F)
    return array(reader, byte & 0x0F, depth)
  if (byte <= 0xBF)
    return text(reader, byte & 0x1F)
  // 0xC1 is reserved: no encoder writes it, so it has no reader.
  const read = FIXED[byte]
  if (read === undefined)
    throw new Invalid()
  return read(reader, depth)
}

/**
 * The frame as a JSON value when it is exactly one MessagePack map or array, otherwise
 * undefined. Binary strings become `<n bytes>`, extensions `<extension t, n bytes>` (timestamps
 * become ISO dates), integers beyond 2^53 their decimal digits.
 */
export function decodeMessagePack(bytes: Uint8Array): unknown {
  const first = bytes[0]
  if (first === undefined)
    return undefined
  const container = (first >= 0x80 && first <= 0x9F) || (first >= 0xDC && first <= 0xDF)
  if (!container)
    return undefined
  const reader = new Reader(bytes)
  try {
    const decoded = value(reader, 0)
    return reader.remaining === 0
      ? decoded
      : undefined
  }
  catch (error) {
    if (error instanceof Invalid)
      return undefined
    throw error
  }
}
