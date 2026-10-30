/**
 * Turns one validated HAR entry into an {@link Exchange}.
 */
import type { Exchange, Initiator, NameValue, RequestEvent } from '../model'
import type { HarEntry } from './har'
import { Buffer } from 'node:buffer'
import { baseMimeType, decodeBody, decodeContentEncoding } from './body'
import { normalizeHeaders, parseCookieHeader, responseSetCookies } from './headers'

/** `sec-fetch-dest` values mapped to Playwright resource types. */
const FETCH_DEST_TYPES: Record<string, string> = {
  document: 'document',
  iframe: 'document',
  frame: 'document',
  script: 'script',
  worker: 'script',
  sharedworker: 'script',
  serviceworker: 'script',
  style: 'stylesheet',
  image: 'image',
  font: 'font',
  audio: 'media',
  video: 'media',
  track: 'media',
  manifest: 'manifest',
  report: 'beacon',
}

function header(headers: NameValue[], name: string): string | null {
  return headers.find(entry => entry.name === name)?.value ?? null
}

function typeFromMimeType(mimeType: string): string {
  if (mimeType.startsWith('image/'))
    return 'image'
  if (mimeType.startsWith('font/') || mimeType.includes('font'))
    return 'font'
  if (mimeType === 'text/css')
    return 'stylesheet'
  if (mimeType.includes('javascript') || mimeType.includes('ecmascript'))
    return 'script'
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/'))
    return 'media'
  return 'other'
}

/**
 * Playwright's HAR has no resource type, so it is reconstructed: the HAR field when present, then
 * the instrumentation event (it knows fetch from XHR), then Chrome's `sec-fetch-dest` header,
 * then the response media type.
 */
function resolveResourceType(entry: HarEntry, requestHeaders: NameValue[], event: RequestEvent | undefined, responseMimeType: string): string {
  if (entry._resourceType)
    return entry._resourceType.toLowerCase()
  if (event) {
    if (event.via === 'form')
      return 'document'
    return event.via
  }
  const dest = header(requestHeaders, 'sec-fetch-dest')
  if (dest !== null) {
    if (dest === 'empty')
      return 'fetch'
    return FETCH_DEST_TYPES[dest] ?? 'other'
  }
  return typeFromMimeType(responseMimeType)
}

function resolveInitiator(event: RequestEvent | undefined, resourceType: string): Initiator | null {
  if (event)
    return { via: event.via, stack: event.stack }
  if (resourceType === 'document')
    return { via: 'navigation', stack: [] }
  return null
}

type PostData = NonNullable<HarEntry['request']['postData']>

/**
 * The request body and the headers to keep (decision 0050). A body capture saved as raw bytes is
 * decoded with its `content-encoding`; once decoded, that header no longer describes the body the
 * exchange holds, so it is dropped: a client sends the decoded body, and an input whose value the
 * HTTP stack sets is not one the wrapper has to find.
 */
function requestBodyOf(postData: PostData | null | undefined, contentType: string | null | undefined, headers: NameValue[]): { body: Exchange['request']['body'], headers: NameValue[] } {
  if (!postData)
    return { body: null, headers }
  const raw = postData._base64
  if (raw === null || raw === undefined || raw === '') {
    return {
      body: decodeBody({ contentType, text: postData.text, params: postData.params }),
      headers,
    }
  }
  const encoding = header(headers, 'content-encoding')
  const decoded = encoding === null
    ? null
    : decodeContentEncoding(Buffer.from(raw, 'base64'), encoding)
  if (decoded === null) {
    return {
      body: decodeBody({ contentType, text: raw, encoding: 'base64' }),
      headers,
    }
  }
  return {
    body: decodeBody({
      contentType,
      text: decoded.toString('base64'),
      encoding: 'base64',
    }),
    headers: headers.filter(item => item.name !== 'content-encoding'),
  }
}

export interface BuildExchangeInput {
  entry: HarEntry
  harIndex: number
  sessionId: string
  event: RequestEvent | undefined
}

/** Builds the exchange; `seq` is filled in later, once the session is sorted by time. */
export function buildExchange({ entry, harIndex, sessionId, event }: BuildExchangeInput): Exchange | null {
  let url: URL
  try {
    url = new URL(entry.request.url)
  }
  catch {
    return null
  }
  url.hash = ''

  const allRequestHeaders = normalizeHeaders(entry.request.headers)
  const cookieHeader = allRequestHeaders.filter(entry => entry.name === 'cookie').map(entry => entry.value).join('; ')
  const cookies = cookieHeader === ''
    ? (entry.request.cookies ?? []).map(cookie => ({ name: cookie.name, value: cookie.value }))
    : parseCookieHeader(cookieHeader)
  const postData = entry.request.postData
  const requestContentType = postData?.mimeType || header(allRequestHeaders, 'content-type')
  const { body: requestBody, headers: requestHeaders } = requestBodyOf(postData, requestContentType, allRequestHeaders.filter(entry => entry.name !== 'cookie'))

  const allResponseHeaders = normalizeHeaders(entry.response.headers)
  const responseHeaders = allResponseHeaders.filter(entry => entry.name !== 'set-cookie')
  const content = entry.response.content
  const responseContentType = content?.mimeType || header(responseHeaders, 'content-type')

  const resourceType = resolveResourceType(entry, requestHeaders, event, baseMimeType(responseContentType))
  const startedAt = Date.parse(entry.startedDateTime)
  const referer = header(requestHeaders, 'referer')

  return {
    id: `${sessionId}:${harIndex}`,
    sessionId,
    seq: 0,
    startedAt: Number.isNaN(startedAt)
      ? 0
      : startedAt,
    resourceType,
    pageUrl: event?.pageUrl ?? referer,
    request: {
      method: entry.request.method.toUpperCase(),
      url: url.toString(),
      host: url.host,
      path: url.pathname,
      query: [...url.searchParams].map(([name, value]) => ({ name, value })),
      headers: requestHeaders,
      cookies,
      body: requestBody,
    },
    response: {
      status: entry.response.status,
      // A request that got no response has no status text; the browser's error stands in for it.
      statusText: entry.response.statusText || entry.response._failureText || '',
      headers: responseHeaders,
      setCookies: responseSetCookies(entry.response.cookies, allResponseHeaders),
      body: content
        ? decodeBody({ contentType: responseContentType, text: content.text, encoding: content.encoding })
        : null,
    },
    initiator: resolveInitiator(event, resourceType),
    // classify overwrites these; `noise` keeps an unclassified exchange out of every spec.
    kind: 'noise',
    kindReason: 'not classified yet',
  }
}
