/**
 * Header and cookie normalisation for HAR entries.
 */
import type { NameValue, SetCookie } from '../model'
import type { HarCookie } from './har'

/** Lower-cases header names and drops HTTP/2 pseudo headers (`:authority`, `:path`, ...). */
export function normalizeHeaders(headers: NameValue[]): NameValue[] {
  return headers
    .filter(header => !header.name.startsWith(':'))
    .map(header => ({
      name: header.name.toLowerCase(),
      value: header.value,
    }))
}

/** Splits a `Cookie` request header into name/value pairs. */
export function parseCookieHeader(value: string): NameValue[] {
  const cookies: NameValue[] = []
  for (const part of value.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '')
      continue
    const equals = trimmed.indexOf('=')
    const name = (equals === -1
      ? trimmed
      : trimmed.slice(0, equals)).trim()
    if (name === '')
      continue
    cookies.push({
      name,
      value: equals === -1
        ? ''
        : trimmed.slice(equals + 1).trim(),
    })
  }
  return cookies
}

/** Parses one `Set-Cookie` header line. */
export function parseSetCookie(line: string): SetCookie | null {
  const [pair = '', ...attributes] = line.split(';')
  const equals = pair.indexOf('=')
  if (equals <= 0)
    return null
  const cookie: SetCookie = {
    name: pair.slice(0, equals).trim(),
    value: pair.slice(equals + 1).trim(),
    domain: null,
    path: null,
    expires: null,
    httpOnly: false,
    secure: false,
    sameSite: null,
  }
  for (const attribute of attributes) {
    const [rawKey = '', ...rest] = attribute.split('=')
    const key = rawKey.trim().toLowerCase()
    const value = rest.join('=').trim()
    if (key === 'domain')
      cookie.domain = value
    else if (key === 'path')
      cookie.path = value
    else if (key === 'expires')
      cookie.expires = value
    else if (key === 'httponly')
      cookie.httpOnly = true
    else if (key === 'secure')
      cookie.secure = true
    else if (key === 'samesite')
      cookie.sameSite = value
  }
  return cookie
}

/**
 * Set-Cookie values of a response. HAR `cookies` arrays are preferred; some writers leave them
 * empty, so the `set-cookie` headers (one per line, Playwright joins them with newlines) are the
 * fallback.
 */
export function responseSetCookies(harCookies: HarCookie[] | null | undefined, headers: NameValue[]): SetCookie[] {
  if (harCookies && harCookies.length > 0) {
    return harCookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? null,
      path: cookie.path ?? null,
      expires: cookie.expires ?? null,
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? false,
      sameSite: cookie.sameSite ?? null,
    }))
  }
  return headers
    .filter(header => header.name === 'set-cookie')
    .flatMap(header => header.value.split('\n'))
    .map(parseSetCookie)
    .filter((cookie): cookie is SetCookie => cookie !== null)
}
