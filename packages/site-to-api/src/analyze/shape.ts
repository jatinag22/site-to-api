/**
 * Describes what a value looks like without revealing it, e.g. `32 hex chars` or
 * `JWT (alg=RS256, claims=[exp, sub])`. Used wherever a secret is replaced in the output.
 */

const HEX = /^[0-9a-f]+$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BASE64 = /^[\w+/-]+={0,2}$/
const DIGITS = /^\d+$/

function decodeBase64Url(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return atob(padded)
  }
  catch {
    return null
  }
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null)
    return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }
  catch {
    return null
  }
}

/** Returns the header and claim names of a JWT, or `null` when the value is not one. */
export function inspectJwt(value: string): { alg: string | null, claims: string[] } | null {
  const parts = value.split('.')
  if (parts.length !== 3 || parts.some(part => part.length === 0))
    return null
  const header = parseJsonObject(decodeBase64Url(parts[0]!))
  const payload = parseJsonObject(decodeBase64Url(parts[1]!))
  if (!header || !payload || typeof header.alg !== 'string')
    return null
  return {
    alg: header.alg,
    claims: Object.keys(payload).sort(),
  }
}

/** A short, value-free description of a string's format. */
export function describeShape(value: string): string {
  const jwt = inspectJwt(value)
  if (jwt)
    return `JWT (alg=${jwt.alg ?? 'unknown'}, claims=[${jwt.claims.join(', ')}])`
  if (UUID.test(value))
    return 'UUID'
  if (DIGITS.test(value))
    return `${value.length}-digit number`
  if (HEX.test(value))
    return `${value.length} hex chars`
  if (BASE64.test(value) && value.length >= 16)
    return `${value.length} base64 chars`
  const separators = [
    ...new Set(value.replace(/[\w=+/-]/g, '')),
  ].sort().join('')
  return separators
    ? `${value.length} chars, separators "${separators}"`
    : `${value.length} chars`
}
