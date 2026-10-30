/**
 * Extracts the values a request sends and the values a response returns, each with its
 * location, so value tracing can compare them.
 */
import type { Exchange, ValueLocation } from '../../model'

/** A value and where it sits in an exchange. `name` is the field name used for matching. */
export interface LocatedValue {
  location: ValueLocation
  value: string
  /** Header, query, cookie or form name, or the last segment of a JSON Pointer. */
  name: string | null
}

/**
 * Request headers the browser sets on its own. Tracing them would only produce noise: the page
 * cannot choose their values, so they never depend on an earlier response.
 */
const BROWSER_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  // Names how the body was compressed; load decodes the body and drops it (decision 0049).
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'dnt',
  'host',
  'if-modified-since',
  'if-none-match',
  'origin',
  'pragma',
  'priority',
  'referer',
  'te',
  'upgrade-insecure-requests',
  'user-agent',
])

/**
 * Response headers that describe the transfer, not data a later request could reuse. `cookie`
 * is a request header: in a response (some bot-protection pages reflect it) it holds what the
 * browser sent, never a value the server produced.
 */
const TRANSPORT_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'age',
  'alt-svc',
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'content-security-policy',
  'content-type',
  'cookie',
  'date',
  'expires',
  'keep-alive',
  'last-modified',
  'server',
  'set-cookie',
  'strict-transport-security',
  'transfer-encoding',
  'vary',
  'via',
  'x-content-type-options',
  'x-frame-options',
  'x-xss-protection',
])

function isBrowserHeader(name: string): boolean {
  return BROWSER_REQUEST_HEADERS.has(name) || name.startsWith('sec-')
}

/** Escapes one JSON Pointer reference token (RFC 6901). */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

function lastPointerName(pointer: string): string | null {
  const tokens = pointer.split('/').slice(1).filter(token => !/^\d+$/.test(token))
  const last = tokens.at(-1)
  return last === undefined
    ? null
    : last.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * String and number leaves of a JSON value with their JSON Pointers, in document order.
 * Booleans and `null` are skipped because they cannot identify a producer.
 */
function jsonLeaves(value: unknown, pointer = ''): Array<{ pointer: string, value: string }> {
  if (typeof value === 'string') {
    return [
      { pointer, value },
    ]
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? [
          {
            pointer,
            value: String(value),
          },
        ]
      : []
  }
  if (Array.isArray(value))
    return value.flatMap((item: unknown, index) => jsonLeaves(item, `${pointer}/${index}`))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]: [string, unknown]) =>
      jsonLeaves(item, `${pointer}/${escapePointerToken(key)}`))
  }
  return []
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

/** Every value a request sends, in a fixed order: path, query, headers, cookies, body. */
export function requestValues(exchange: Exchange): LocatedValue[] {
  const { request } = exchange
  const values: LocatedValue[] = []
  // Keep empty segments so indexes match the operation's path template positions.
  request.path.replace(/^\//, '').split('/').forEach((segment, index) => {
    if (segment) {
      values.push({
        location: { in: 'path', index },
        value: safeDecode(segment),
        name: null,
      })
    }
  })
  for (const { name, value } of request.query) {
    values.push({
      location: { in: 'query', name },
      value,
      name,
    })
  }
  for (const { name, value } of request.headers) {
    if (!isBrowserHeader(name)) {
      values.push({
        location: { in: 'header', name },
        value,
        name,
      })
    }
  }
  for (const { name, value } of request.cookies) {
    values.push({
      location: { in: 'cookie', name },
      value,
      name,
    })
  }
  const body = request.body
  if (body && body.json !== undefined) {
    for (const leaf of jsonLeaves(body.json)) {
      values.push({
        location: { in: 'body', pointer: leaf.pointer },
        value: leaf.value,
        name: lastPointerName(leaf.pointer),
      })
    }
  }
  else if (body?.form) {
    for (const { name, value } of body.form) {
      values.push({
        location: { in: 'form', name },
        value,
        name,
      })
    }
  }
  return values
}

/** Values a response returns as structured data: JSON leaves, Set-Cookie and data headers. */
export function responseValues(exchange: Exchange): LocatedValue[] {
  const { response } = exchange
  const values: LocatedValue[] = []
  if (response.body && response.body.json !== undefined) {
    for (const leaf of jsonLeaves(response.body.json)) {
      values.push({
        location: { in: 'body', pointer: leaf.pointer },
        value: leaf.value,
        name: lastPointerName(leaf.pointer),
      })
    }
  }
  for (const cookie of response.setCookies) {
    values.push({
      location: { in: 'set-cookie', name: cookie.name },
      value: cookie.value,
      name: cookie.name,
    })
  }
  for (const { name, value } of response.headers) {
    if (!TRANSPORT_RESPONSE_HEADERS.has(name)) {
      values.push({
        location: { in: 'response-header', name },
        value,
        name,
      })
    }
  }
  return values
}

/** Text of an HTML or other non-JSON text response, where values are found by substring. */
export function responseText(exchange: Exchange): string | null {
  const body = exchange.response.body
  if (!body || body.json !== undefined || body.text === null)
    return null
  return body.text
}
