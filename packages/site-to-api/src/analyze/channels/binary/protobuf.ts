/**
 * A protobuf wire-format reader that needs no `.proto` file. It reads a frame only when it parses
 * fully and plausibly: every byte consumed, wire types 0, 1, 2 and 5, field numbers in a sane
 * range, lengths inside the frame, and one wire type per field number. Without the schema there
 * are no field names, so fields are written as `field 3 (varint)` (decision 0038).
 */

/** Field numbers above this are legal but no real schema uses them; they mark random bytes. */
const MAX_FIELD_NUMBER = 65_535
/** 19000-19999 are reserved by protobuf itself. */
const RESERVED_FIELDS = { from: 19_000, to: 19_999 }
const MAX_DEPTH = 8

type WireType = 0 | 1 | 2 | 5

class Invalid extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true })

interface Field {
  number: number
  label: 'varint' | 'fixed64' | 'fixed32' | 'string' | 'bytes' | 'message'
  value: unknown
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint, next: number } {
  let value = 0n
  let shift = 0n
  for (let offset = start; offset < bytes.length && offset < start + 10; offset++) {
    const byte = bytes[offset] ?? 0
    value |= BigInt(byte & 0x7F) << shift
    if ((byte & 0x80) === 0)
      return { value, next: offset + 1 }
    shift += 7n
  }
  throw new Invalid()
}

function asNumber(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString()
}

/** Printable UTF-8 text: no control characters other than tab and line breaks. */
function readableText(bytes: Uint8Array): string | null {
  let decoded: string
  try {
    decoded = utf8.decode(bytes)
  }
  catch {
    return null
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what marks bytes that are not text
  return /[\u0000-\u0008\v\f\u000E-\u001F\u007F]/.test(decoded)
    ? null
    : decoded
}

function lengthDelimited(bytes: Uint8Array, depth: number): Pick<Field, 'label' | 'value'> {
  const decoded = readableText(bytes)
  if (decoded !== null)
    return { label: 'string', value: decoded }
  const nested = depth < MAX_DEPTH
    ? readMessage(bytes, depth + 1)
    : null
  return nested === null
    ? { label: 'bytes', value: `<${bytes.length} bytes>` }
    : { label: 'message', value: nested }
}

function readField(bytes: Uint8Array, offset: number, depth: number): { field: Field, next: number } {
  const tag = readVarint(bytes, offset)
  const wire = Number(tag.value & 7n)
  const number = Number(tag.value >> 3n)
  if (number < 1 || number > MAX_FIELD_NUMBER || (number >= RESERVED_FIELDS.from && number <= RESERVED_FIELDS.to))
    throw new Invalid()
  if (wire !== 0 && wire !== 1 && wire !== 2 && wire !== 5)
    throw new Invalid()
  const type: WireType = wire
  let at = tag.next
  switch (type) {
    case 0: {
      const varint = readVarint(bytes, at)
      return {
        field: {
          number,
          label: 'varint',
          value: asNumber(varint.value),
        },
        next: varint.next,
      }
    }
    case 1: {
      if (at + 8 > bytes.length)
        throw new Invalid()
      const view = new DataView(bytes.buffer, bytes.byteOffset + at, 8)
      return {
        field: {
          number,
          label: 'fixed64',
          value: asNumber(view.getBigUint64(0, true)),
        },
        next: at + 8,
      }
    }
    case 5: {
      if (at + 4 > bytes.length)
        throw new Invalid()
      const view = new DataView(bytes.buffer, bytes.byteOffset + at, 4)
      return {
        field: {
          number,
          label: 'fixed32',
          value: view.getUint32(0, true),
        },
        next: at + 4,
      }
    }
    case 2: {
      const length = readVarint(bytes, at)
      at = length.next
      const end = at + Number(length.value)
      if (length.value > BigInt(bytes.length) || end > bytes.length)
        throw new Invalid()
      return {
        field: {
          number,
          ...lengthDelimited(bytes.subarray(at, end), depth),
        },
        next: end,
      }
    }
  }
}

/**
 * The fields of one message keyed `field <n> (<type>)`, a repeated field as an array; null when
 * the bytes are not a plausible message.
 */
function readMessage(bytes: Uint8Array, depth: number): Record<string, unknown> | null {
  if (bytes.length === 0)
    return null
  const fields: Field[] = []
  try {
    let offset = 0
    while (offset < bytes.length) {
      const { field, next } = readField(bytes, offset, depth)
      fields.push(field)
      offset = next
    }
  }
  catch (error) {
    if (error instanceof Invalid)
      return null
    throw error
  }
  const wireOf = new Map<number, string>()
  const grouped = new Map<string, unknown[]>()
  for (const field of fields) {
    // A string and a message are both wire type 2, so they may share a number; other types may not.
    const wire = field.label === 'string' || field.label === 'bytes' || field.label === 'message'
      ? 'delimited'
      : field.label
    if ((wireOf.get(field.number) ?? wire) !== wire)
      return null
    wireOf.set(field.number, wire)
    const key = `field ${field.number} (${field.label})`
    grouped.set(key, [
      ...(grouped.get(key) ?? []),
      field.value,
    ])
  }
  return Object.fromEntries([...grouped]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([key, values]) => [
      key,
      values.length === 1
        ? values[0]
        : values,
    ]))
}

/**
 * The frame read as a protobuf message without its schema, or undefined when it does not parse
 * fully and plausibly. Length-delimited fields are a string when they hold printable UTF-8, a
 * nested message when they parse as one, otherwise `<n bytes>`.
 */
export function decodeProtobuf(bytes: Uint8Array): Record<string, unknown> | undefined {
  // A field needs a tag and a value: one byte is never a message.
  if (bytes.length < 2)
    return undefined
  return readMessage(bytes, 0) ?? undefined
}
