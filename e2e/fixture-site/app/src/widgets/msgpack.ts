/**
 * Just enough MessagePack for the basket widget and its server: maps with string keys, arrays,
 * strings, integers, doubles, booleans and nil. Hand-rolled so the fixture needs no dependency.
 */
export type Packable = null | boolean | number | string | Packable[] | { [key: string]: Packable }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function header(out: number[], small: number, base: number, wide: [number, number], length: number): void {
  if (length < small)
    out.push(base | length)
  else
    out.push(wide[0], length >> 8, length & 0xFF)
}

function packNumber(value: number, out: number[]): void {
  if (Number.isInteger(value) && value >= 0 && value < 0x80) {
    out.push(value)
    return
  }
  if (Number.isInteger(value) && value >= 0 && value <= 0xFFFF_FFFF) {
    out.push(0xCE, (value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF)
    return
  }
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  out.push(0xCB, ...new Uint8Array(view.buffer))
}

function packString(value: string, out: number[]): void {
  const bytes = encoder.encode(value)
  if (bytes.length < 32)
    out.push(0xA0 | bytes.length)
  else
    out.push(0xDA, bytes.length >> 8, bytes.length & 0xFF)
  out.push(...bytes)
}

function pack(value: Packable, out: number[]): void {
  if (value === null || typeof value === 'boolean') {
    out.push(value === null
      ? 0xC0
      : value
        ? 0xC3
        : 0xC2)
  }
  else if (typeof value === 'number') {
    packNumber(value, out)
  }
  else if (typeof value === 'string') {
    packString(value, out)
  }
  else if (Array.isArray(value)) {
    header(out, 16, 0x90, [0xDC, 0], value.length)
    for (const item of value)
      pack(item, out)
  }
  else {
    const entries = Object.entries(value)
    header(out, 16, 0x80, [0xDE, 0], entries.length)
    for (const [key, item] of entries) {
      packString(key, out)
      pack(item, out)
    }
  }
}

export function encode(value: Packable): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  pack(value, out)
  return new Uint8Array(out)
}

function unpack(view: DataView, at: { offset: number }): Packable {
  const byte = view.getUint8(at.offset++)
  const take = (count: number): number => {
    const start = at.offset
    at.offset += count
    return start
  }
  const text = (length: number): string => decoder.decode(new Uint8Array(view.buffer, view.byteOffset + take(length), length))
  const list = (length: number): Packable[] => Array.from({ length }, () => unpack(view, at))
  const map = (length: number): Record<string, Packable> => {
    const result: Record<string, Packable> = {}
    for (let i = 0; i < length; i++) {
      const key = unpack(view, at)
      result[String(key)] = unpack(view, at)
    }
    return result
  }
  if (byte < 0x80)
    return byte
  if (byte < 0x90)
    return map(byte & 0x0F)
  if (byte < 0xA0)
    return list(byte & 0x0F)
  if (byte < 0xC0)
    return text(byte & 0x1F)
  switch (byte) {
    case 0xC0: return null
    case 0xC2: return false
    case 0xC3: return true
    case 0xCB: return view.getFloat64(take(8))
    case 0xCE: return view.getUint32(take(4))
    case 0xDA: return text(view.getUint16(take(2)))
    case 0xDC: return list(view.getUint16(take(2)))
    case 0xDE: return map(view.getUint16(take(2)))
    default: throw new Error(`msgpack: type byte ${byte} is not supported`)
  }
}

export function decode(bytes: Uint8Array): Packable {
  return unpack(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), { offset: 0 })
}
