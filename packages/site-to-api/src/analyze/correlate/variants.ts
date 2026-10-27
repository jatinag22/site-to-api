/**
 * Encodings a value can pass through between the response that produced it and the request
 * that sends it.
 */
import { Buffer } from 'node:buffer'

export type MatchTransform = 'none' | 'url-encoded' | 'base64' | 'json-string' | 'substring'

/** Lower is a stronger match. An exact match always beats an encoded one. */
export const TRANSFORM_RANK: Readonly<Record<MatchTransform, number>> = {
  'none': 0,
  'url-encoded': 1,
  'json-string': 2,
  'base64': 3,
  'substring': 4,
}

export interface Variant {
  value: string
  transform: MatchTransform
}

const BASE64 = /^[\w+/-]+={0,2}$/
/**
 * Decoded base64 with control characters or invalid UTF-8 is binary, not a value a response
 * returned as text.
 */
function isBinary(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code < 0x20 && char !== '\t' && char !== '\n' && char !== '\r') || code === 0xFFFD)
      return true
  }
  return false
}

function tryDecodeUri(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  }
  catch {
    return null
  }
}

function tryDecodeBase64(value: string): string | null {
  if (!BASE64.test(value) || value.length % 4 === 1)
    return null
  const decoded = Buffer.from(value, value.includes('-') || value.includes('_')
    ? 'base64url'
    : 'base64').toString('utf8')
  return isBinary(decoded)
    ? null
    : decoded
}

function tryParseJsonString(value: string): string | null {
  const quoted = value.startsWith('"') && value.endsWith('"')
    ? value
    : `"${value}"`
  try {
    const parsed: unknown = JSON.parse(quoted)
    return typeof parsed === 'string'
      ? parsed
      : null
  }
  catch {
    return null
  }
}

/**
 * The forms a sent value could have had in the response, each with the transform that links
 * them. Works both ways: the request may carry the encoded form of a response value, or a
 * decoded form of an encoded response value. The value itself comes first.
 */
export function variantsOf(value: string, minLength: number): Variant[] {
  const variants: Variant[] = [
    { value, transform: 'none' },
  ]
  const seen = new Set([value])
  const add = (candidate: string | null, transform: MatchTransform): void => {
    if (candidate === null || candidate.length < minLength || seen.has(candidate))
      return
    seen.add(candidate)
    variants.push({ value: candidate, transform })
  }
  add(tryDecodeUri(value), 'url-encoded')
  add(encodeURIComponent(value), 'url-encoded')
  const escaped = JSON.stringify(value)
  add(escaped.slice(1, -1), 'json-string')
  if (value.includes('\\') || value.startsWith('"'))
    add(tryParseJsonString(value), 'json-string')
  const encoded = Buffer.from(value, 'utf8')
  add(encoded.toString('base64'), 'base64')
  add(encoded.toString('base64').replace(/=+$/, ''), 'base64')
  add(encoded.toString('base64url'), 'base64')
  add(tryDecodeBase64(value), 'base64')
  return variants
}
