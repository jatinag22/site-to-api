import type { CookieJar } from '../cookies'

/**
 * How a client authenticates. `createFetch` calls `prepare` before every request and, when a
 * response fails, `onAuthFailure` at most once per request: returning true re-sends the request
 * once (after the session refreshed whatever it holds).
 */
export interface Session {
  /** Jar the session keeps cookies in. `createFetch` sends cookies from it and stores new ones. */
  readonly jar?: CookieJar
  /** Adds credentials to a request. May return the same request or a new one. */
  prepare: (request: Request) => Request | Promise<Request>
  /**
   * Called with a non-2xx response and the request that produced it. Return true to have the
   * request sent again once, false to hand the response to the caller.
   */
  onAuthFailure: (response: Response, request: Request) => boolean | Promise<boolean>
}
