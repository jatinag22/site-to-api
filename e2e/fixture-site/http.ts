import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
/** Small helpers over `node:http` so route handlers stay short. */
import { Buffer } from 'node:buffer'

/** Everything a route handler needs about one request. */
export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  cookies: ReadonlyMap<string, string>
}

/** Parses a `Cookie` request header. Later duplicates win, like browsers send them. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0)
      continue
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()))
  }
  return cookies
}

export interface CookieOptions {
  httpOnly?: boolean
  maxAgeSeconds?: number
}

/** Serialises a `Set-Cookie` value scoped to the whole site. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Lax']
  if (options.maxAgeSeconds !== undefined)
    parts.push(`Max-Age=${options.maxAgeSeconds}`)
  if (options.httpOnly)
    parts.push('HttpOnly')
  return parts.join('; ')
}

const MAX_BODY_BYTES = 64 * 1024

/** Reads a request body as UTF-8, rejecting bodies over 64 KB. */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES)
      throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Sends any body with an explicit content type. */
export function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Uint8Array,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': typeof body === 'string'
      ? Buffer.byteLength(body)
      : body.byteLength,
    ...headers,
  })
  res.end(body)
}

/** Sends a JSON response. */
export function sendJson(res: ServerResponse, status: number, value: unknown, headers: OutgoingHttpHeaders = {}): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), { 'cache-control': 'no-store', ...headers })
}

/** Sends an HTML page. */
export function sendHtml(res: ServerResponse, status: number, html: string, headers: OutgoingHttpHeaders = {}): void {
  send(res, status, 'text/html; charset=utf-8', html, { 'cache-control': 'no-store', ...headers })
}

/** Parses JSON text into `unknown`, returning `undefined` instead of throwing on bad input. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}
