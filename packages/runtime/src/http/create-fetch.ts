import type { Session } from '../session'
import type { RetryOptions } from './retry'
import { CookieJar } from '../cookies'
import { cookieSession } from '../session'
import { backoffDelay, isIdempotent, parseRetryAfter, resolveRetry } from './retry'

/** Options for {@link createFetch}. */
export interface CreateFetchOptions {
  /**
   * Cookie jar. Defaults to the session's jar, or a new empty jar when neither is given, so
   * cookies set by one call are sent on the next.
   */
  jar?: CookieJar
  /** How requests authenticate. Defaults to `cookieSession(jar)`. */
  session?: Session
  /** Retry behaviour, or `false` to send every request once. */
  retry?: RetryOptions | false
  /** Underlying fetch. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Headers added to every request that does not already set them. */
  defaultHeaders?: Record<string, string>
  /**
   * How redirects are followed. `jar` (the default) follows them here so cookies set by each
   * redirect response are stored and sent, which login flows rely on. `native` leaves redirects
   * to the platform's fetch; use it in browsers, where redirect responses are opaque.
   */
  redirects?: 'jar' | 'native'
  /** Called with every request just before it is sent, after credentials were added. */
  onRequest?: (request: Request) => void | Promise<void>
  /** Called with every response, including redirects and responses that are retried. */
  onResponse?: (response: Response, request: Request) => void | Promise<void>
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20

/**
 * A `fetch` with a cookie jar, session credentials, default headers and retries. Pass it to a
 * generated client, or call it directly.
 *
 * - Cookies from `Set-Cookie` (including on redirects) go into the jar and are sent back on
 *   matching requests; a `Cookie` header set by the caller wins over the jar for the same name.
 * - 423, 429, 502, 503, 504 and network errors are retried with exponential backoff and jitter,
 *   honouring `Retry-After`. POST and PATCH are never retried unless `retry.unsafe` is true.
 * - When a response fails, the session may refresh its credentials; the request is then sent
 *   again once.
 *
 * ```ts
 * const fetch = createFetch({ session: tokenSession({ getToken: () => token }) })
 * const response = await fetch('https://api.example.com/me')
 * ```
 */
export function createFetch(options: CreateFetchOptions = {}): typeof fetch {
  const session = options.session ?? cookieSession(options.jar ?? new CookieJar())
  const jar = options.jar ?? session.jar ?? null
  const retry = resolveRetry(options.retry)
  // Looked up per call rather than bound once, so test doubles installed later still apply.
  const baseFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const followHere = jar !== null && options.redirects !== 'native'
  const defaultHeaders = Object.entries(options.defaultHeaders ?? {})

  async function sendOnce(request: Request): Promise<Response> {
    if (jar) {
      const header = mergeCookies(request.headers.get('cookie'), jar.cookieHeader(request.url))
      if (header)
        request.headers.set('cookie', header)
    }
    await options.onRequest?.(request)
    const response = await baseFetch(request)
    jar?.setFromResponse(request.url, response.headers)
    await options.onResponse?.(response, request)
    return response
  }

  async function send(request: Request): Promise<Response> {
    if (!followHere || request.redirect !== 'follow')
      return sendOnce(request)
    const explicitCookie = request.headers.get('cookie')
    let current = request
    for (let hop = 0; ; hop++) {
      // Keep a copy of the body: a 307/308 must re-send it to the new location.
      const spare = current.body === null
        ? null
        : current.clone()
      const response = await sendOnce(new Request(current, { redirect: 'manual' }))
      const location = response.headers.get('location')
      if (!REDIRECT_STATUSES.has(response.status) || location === null)
        return response
      if (hop >= MAX_REDIRECTS)
        throw new TypeError(`createFetch: more than ${MAX_REDIRECTS} redirects starting at ${request.url}`)
      await discard(response)
      current = await redirectRequest(spare ?? current, response.status, new URL(location, current.url), request, explicitCookie)
    }
  }

  async function prepareAttempt(original: Request): Promise<Request> {
    const request = original.clone()
    for (const [name, value] of defaultHeaders) {
      if (!request.headers.has(name))
        request.headers.set(name, value)
    }
    return session.prepare(request)
  }

  /** How long to wait before retrying `response`, or null to hand it to the caller. */
  function retryDelay(response: Response, attempt: number): number | null {
    if (!retry.statuses.includes(response.status))
      return null
    const asked = parseRetryAfter(response.headers.get('retry-after'), retry.now())
    if (asked !== null && asked > retry.maxDelayMs)
      return null
    return asked ?? backoffDelay(retry, attempt)
  }

  return async (input, init) => {
    const original = new Request(input, init)
    const retryable = retry.unsafe || isIdempotent(original.method)
    let attempt = 1
    let refreshed = false
    for (;;) {
      const prepared = await prepareAttempt(original)
      const canRetry = retryable && attempt < retry.attempts
      const outcome = await send(prepared).then(
        response => ({ ok: true as const, response }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      if (!outcome.ok) {
        if (!canRetry || original.signal.aborted || isAbortError(outcome.error))
          throw outcome.error
        await retry.sleep(backoffDelay(retry, attempt), original.signal)
        attempt += 1
        continue
      }

      const { response } = outcome
      if (!response.ok && !refreshed && await session.onAuthFailure(response, prepared)) {
        refreshed = true
        await discard(response)
        continue
      }
      const delay = canRetry
        ? retryDelay(response, attempt)
        : null
      if (delay === null)
        return response
      await discard(response)
      await retry.sleep(delay, original.signal)
      attempt += 1
    }
  }
}

/** Joins the caller's `Cookie` header with the jar's, keeping the caller's value for a name. */
function mergeCookies(explicit: string | null, fromJar: string): string {
  if (!explicit)
    return fromJar
  if (!fromJar)
    return explicit
  const taken = new Set(explicit.split(';').map(part => part.split('=')[0]?.trim()))
  const extra = fromJar.split('; ').filter(part => !taken.has(part.split('=')[0]))
  return [explicit, ...extra].join('; ')
}

/** The request a browser would send after a redirect (Fetch standard, "HTTP-redirect fetch"). */
async function redirectRequest(
  previous: Request,
  status: number,
  location: URL,
  original: Request,
  explicitCookie: string | null,
): Promise<Request> {
  const method = previous.method.toUpperCase()
  const toGet = ((status === 301 || status === 302) && method === 'POST')
    || (status === 303 && method !== 'GET' && method !== 'HEAD')
  const headers = new Headers(previous.headers)
  headers.delete('cookie')
  const sameOrigin = location.origin === new URL(original.url).origin
  if (sameOrigin && explicitCookie)
    headers.set('cookie', explicitCookie)
  if (!sameOrigin)
    headers.delete('authorization')
  if (toGet) {
    for (const name of [
      'content-type',
      'content-length',
      'content-encoding',
      'content-language',
      'content-location',
    ])
      headers.delete(name)
  }
  const body = toGet || previous.body === null
    ? null
    : await previous.arrayBuffer()
  return new Request(location, {
    method: toGet ? 'GET' : method,
    headers,
    body,
    redirect: 'follow',
    // `credentials` and `referrerPolicy` are left out on purpose: Cloudflare Workers rejects them.
    signal: original.signal,
  })
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  }
  catch {
    // A body that cannot be cancelled is already closed; nothing else depends on it.
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
