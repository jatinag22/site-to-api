import type { CookieJar, SetCookieOptions } from '../cookies'
import type { Session } from './types'

/**
 * The default session: cookies only. Whatever the site sets is kept in `jar` and sent back,
 * which is all most cookie-based sites need once you have called their login endpoint.
 */
export function cookieSession(jar: CookieJar): Session {
  return {
    jar,
    prepare: request => request,
    onAuthFailure: () => false,
  }
}

/** Options for {@link tokenSession}. */
export interface TokenSessionOptions {
  /** Returns the current token. Called before every request, so it can read from a cache. */
  getToken: () => string | Promise<string>
  /**
   * Obtains a new token after a 401. Concurrent failures share one call. Without it, a 401 is
   * returned to the caller unchanged.
   */
  refresh?: () => unknown
  /** Header that carries the token. Defaults to `Authorization`. */
  header?: string
  /** Prefix before the token, e.g. `Bearer`; `null` sends the bare token. Defaults to `Bearer`. */
  scheme?: string | null
  /** Statuses that mean the token is no longer valid. Defaults to `[401]`. */
  refreshOn?: number[]
  /** Optional jar for sites that use cookies alongside the token. */
  jar?: CookieJar
}

/**
 * Sends a token in a header (`Authorization: Bearer <token>` by default) and refreshes it once
 * when the site answers 401.
 */
export function tokenSession(options: TokenSessionOptions): Session {
  const header = options.header ?? 'Authorization'
  const scheme = options.scheme === undefined
    ? 'Bearer'
    : options.scheme
  const refreshOn = options.refreshOn ?? [401]
  const refresh = options.refresh
  const refresher = refresh
    ? createRefresher(async () => {
        await refresh()
      })
    : null
  return {
    jar: options.jar,
    async prepare(request) {
      const token = await options.getToken()
      request.headers.set(header, scheme === null
        ? token
        : `${scheme} ${token}`)
      refresher?.mark(request)
      return request
    },
    async onAuthFailure(response, request) {
      if (!refresher || !refreshOn.includes(response.status))
        return false
      await refresher.refreshFor(request)
      return true
    },
  }
}

/**
 * A cookie as a browser automation tool reports it. Matches Playwright's
 * `BrowserContext.cookies()`: `expires` is in seconds since the epoch, `-1` for a session cookie,
 * and a `domain` with a leading dot applies to subdomains too.
 */
export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path?: string
  expires?: number
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** Options for {@link browserSession}. */
export interface BrowserSessionOptions {
  /**
   * Loads the site in a real browser and returns its cookies. You supply the browser (for
   * example a Playwright script), so this package has no browser dependency.
   */
  bootstrap: () => Promise<BrowserCookie[]>
  /** Jar the browser cookies are copied into and plain HTTP requests are sent from. */
  jar: CookieJar
  /** Statuses that mean the cookies went stale. Defaults to `[401, 403]`. */
  refreshOn?: number[]
}

/** A {@link Session} that can also be refreshed on demand. */
export interface BrowserSession extends Session {
  readonly jar: CookieJar
  /** Runs `bootstrap` again now (or joins a run in progress) and copies its cookies into the jar. */
  refresh: () => Promise<void>
}

/**
 * A session for sites that only work after their own scripts ran in a real browser, such as
 * sites behind bot protection (decision 0008). A real browser loads the page, its cookies are
 * reused for plain HTTP calls, and when the site starts answering 401/403 the browser is asked
 * again. Nothing here imitates the browser or the protection; it only reuses the cookies a real
 * browser legitimately received.
 *
 * `bootstrap` runs before the first request and again on a refresh status, at most once per
 * request; concurrent refreshes share one browser run.
 *
 * ```ts
 * import { chromium } from 'playwright'
 *
 * const jar = new CookieJar()
 * const session = browserSession({
 *   jar,
 *   async bootstrap() {
 *     const browser = await chromium.launch()
 *     try {
 *       const context = await browser.newContext()
 *       const page = await context.newPage()
 *       await page.goto('https://www.example.com/')
 *       return await context.cookies()
 *     }
 *     finally {
 *       await browser.close()
 *     }
 *   },
 * })
 * const fetch = createFetch({ session })
 * ```
 */
export function browserSession(options: BrowserSessionOptions): BrowserSession {
  const { jar } = options
  const refreshOn = options.refreshOn ?? [401, 403]
  const refresher = createRefresher(async () => {
    const cookies = await options.bootstrap()
    for (const cookie of cookies)
      jar.set(cookie.name, cookie.value, browserCookieOptions(cookie))
  })

  return {
    jar,
    refresh: () => refresher.run(),
    async prepare(request) {
      if (refresher.generation() === 0)
        await refresher.run()
      refresher.mark(request)
      return request
    },
    async onAuthFailure(response, request) {
      if (!refreshOn.includes(response.status))
        return false
      await refresher.refreshFor(request)
      return true
    },
  }
}

function browserCookieOptions(cookie: BrowserCookie): SetCookieOptions {
  return {
    domain: cookie.domain,
    hostOnly: !cookie.domain.startsWith('.'),
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite
      ? lowerSameSite(cookie.sameSite)
      : null,
    expires: cookie.expires === undefined || cookie.expires < 0
      ? null
      : cookie.expires * 1000,
  }
}

function lowerSameSite(value: 'Strict' | 'Lax' | 'None'): 'strict' | 'lax' | 'none' {
  if (value === 'Strict')
    return 'strict'
  return value === 'Lax'
    ? 'lax'
    : 'none'
}

interface Refresher {
  /** Runs the refresh, or joins the one in flight. */
  run: () => Promise<void>
  /** Completed refreshes so far. */
  generation: () => number
  /** Records which credentials a request was sent with. */
  mark: (request: Request) => void
  /**
   * Refreshes for a failed request, unless a refresh already completed after the request was
   * prepared: then the request only needs re-sending with the newer credentials.
   */
  refreshFor: (request: Request) => Promise<void>
}

/** Serialises refreshes: one call in flight at a time, shared by every caller that arrives. */
function createRefresher(fn: () => Promise<void>): Refresher {
  let inFlight: Promise<void> | null = null
  let generation = 0
  const sentWith = new WeakMap<Request, number>()
  const run = (): Promise<void> => {
    inFlight ??= fn().then(() => {
      generation += 1
    }).finally(() => {
      inFlight = null
    })
    return inFlight
  }
  return {
    run,
    generation: () => generation,
    mark: request => sentWith.set(request, generation),
    refreshFor: async (request) => {
      const preparedAt = sentWith.get(request)
      if (preparedAt === undefined || preparedAt === generation)
        await run()
      else
        await inFlight
    },
  }
}
