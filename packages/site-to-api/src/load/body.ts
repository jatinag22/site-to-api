/**
 * Decoding of HAR bodies into {@link Body}: base64, JSON detection, urlencoded and multipart forms.
 */
import type { Body, NameValue } from '../model'
import { Buffer } from 'node:buffer'
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'

/** Prefixes sites put in front of JSON to stop it being loaded as a script (XSSI protection). */
const XSSI_PREFIXES = [
  ')]}\'\n',
  ')]}\',\n',
  ')]}\'',
  'while(1);',
  'for(;;);',
]

/** Media type without parameters, lower-cased. */
export function baseMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0]!.trim().toLowerCase()
}

/** True for media types whose bodies are text. */
function isTextualMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/')
    || /json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|ndjson|csv|yaml/.test(mimeType)
}

/**
 * Text without the prefix a site puts in front of JSON so it cannot be loaded as a script
 * (`)]}'`, `while(1);`), leading whitespace dropped; the text itself when it has none.
 */
export function withoutXssiPrefix(text: string): string {
  const candidate = text.trimStart()
  for (const prefix of XSSI_PREFIXES) {
    if (candidate.startsWith(prefix))
      return candidate.slice(prefix.length).trimStart()
  }
  return candidate
}

/** Parses JSON, also when the content type is wrong or an XSSI prefix precedes it. */
function parseJsonLoose(text: string, mimeType: string): unknown {
  const candidate = withoutXssiPrefix(text)
  const looksLikeJson = candidate.startsWith('{') || candidate.startsWith('[')
  if (!looksLikeJson && !mimeType.includes('json'))
    return undefined
  try {
    return JSON.parse(candidate) as unknown
  }
  catch {
    return undefined
  }
}

/** Splits `application/x-www-form-urlencoded` text into fields. */
function parseUrlEncoded(text: string): NameValue[] {
  return [
    ...new URLSearchParams(text),
  ].map(([name, value]) => ({ name, value }))
}

/**
 * Basic `multipart/form-data` parsing: field names and text values. File parts keep only their
 * file name, because their contents are not useful for API documentation.
 */
function parseMultipart(text: string, contentType: string): NameValue[] | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary)
    return null
  const fields: NameValue[] = []
  for (const rawPart of text.split(`--${boundary}`)) {
    const part = rawPart.replace(/^\r?\n/, '')
    if (part === '' || part.startsWith('--'))
      continue
    const separator = /\r?\n\r?\n/.exec(part)
    if (!separator)
      continue
    const head = part.slice(0, separator.index)
    const content = part.slice(separator.index + separator[0].length).replace(/\r?\n$/, '')
    const name = /name="([^"]*)"/i.exec(head)?.[1]
    if (name === undefined)
      continue
    const fileName = /filename="([^"]*)"/i.exec(head)?.[1]
    fields.push({ name, value: fileName ?? content })
  }
  return fields
}

export interface RawBody {
  /** Full content type, parameters included (multipart needs the boundary). */
  contentType: string | null | undefined
  text: string | null | undefined
  encoding?: string | null | undefined
  /** Form fields as HAR reports them, when it does. */
  params?: Array<{ name: string, value?: string | null, fileName?: string | null }> | null
}

function decodeText(raw: RawBody, mimeType: string): { text: string | null, base64: string | null } {
  const content = raw.text ?? ''
  if (raw.encoding !== 'base64')
    return { text: content, base64: null }
  const bytes = Buffer.from(content, 'base64')
  if (isTextualMimeType(mimeType)) {
    return {
      text: bytes.toString('utf8'),
      base64: null,
    }
  }
  if (mimeType !== '')
    return { text: null, base64: content }
  // No media type at all: treat it as text only when it decodes as clean UTF-8.
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // eslint-disable-next-line no-control-regex -- control characters are exactly what marks binary data
    if (!/[\u0000-\u0008\u000E-\u001F]/.test(text))
      return { text, base64: null }
  }
  catch {
    // Not UTF-8: it is binary.
  }
  return { text: null, base64: content }
}

/**
 * Decoded request bodies larger than this are not decoded: a few kilobytes of gzip can expand to
 * gigabytes (a zip bomb), and no API request body worth documenting is this large.
 */
export const MAX_DECODED_BODY_BYTES = 8 * 1024 * 1024

function decodeOne(bytes: Buffer, coding: string): Buffer | null {
  const limit = { maxOutputLength: MAX_DECODED_BODY_BYTES }
  switch (coding) {
    case 'identity':
      return bytes
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(bytes, limit)
    case 'deflate':
      // Servers and clients disagree on whether `deflate` has the zlib wrapper; accept both.
      try {
        return inflateSync(bytes, limit)
      }
      catch {
        return inflateRawSync(bytes, limit)
      }
    case 'br':
      return brotliDecompressSync(bytes, limit)
    default:
      return null
  }
}

/**
 * Undoes a `content-encoding` (decision 0050): `gzip`, `deflate`, `br` or `identity`, several
 * in the order they were applied (`gzip, br`). Null when a coding is unknown, the data is
 * corrupt, or the result would pass {@link MAX_DECODED_BODY_BYTES}.
 */
export function decodeContentEncoding(bytes: Buffer, contentEncoding: string): Buffer | null {
  const codings = contentEncoding.split(',').map(coding => coding.trim().toLowerCase()).filter(coding => coding !== '')
  let current: Buffer | null = bytes
  try {
    for (const coding of codings.reverse()) {
      current = decodeOne(current, coding)
      if (current === null)
        return null
    }
  }
  catch {
    // Corrupt data, or output past the limit (zlib throws `ERR_BUFFER_TOO_LARGE`).
    return null
  }
  return current
}

/** Builds a {@link Body} from HAR data, or `null` when there is no body at all. */
export function decodeBody(raw: RawBody): Body | null {
  const hasParams = (raw.params?.length ?? 0) > 0
  if ((raw.text === null || raw.text === undefined || raw.text === '') && !hasParams)
    return null
  const mimeType = baseMimeType(raw.contentType)
  const { text, base64 } = decodeText(raw, mimeType)
  const json = text === null
    ? undefined
    : parseJsonLoose(text, mimeType)
  let form: NameValue[] | null = null
  if (mimeType === 'application/x-www-form-urlencoded') {
    form = text === null
      ? null
      : parseUrlEncoded(text)
  }
  else if (mimeType === 'multipart/form-data') {
    form = text === null
      ? null
      : parseMultipart(text, raw.contentType ?? '')
  }
  if (form === null && hasParams && (mimeType === 'application/x-www-form-urlencoded' || mimeType === 'multipart/form-data'))
    form = (raw.params ?? []).map(param => ({ name: param.name, value: param.fileName ?? param.value ?? '' }))
  return { mimeType, text, base64, json, form }
}
