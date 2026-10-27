/** Longest response body kept on an error, so a large HTML error page does not flood logs. */
const MAX_BODY_LENGTH = 4096

/** Details of a failed HTTP call. */
export interface SiteApiErrorInit {
  status: number
  statusText: string
  url: string
  method: string
  /** Response body as text, truncated to 4 KiB. */
  body: string
}

/**
 * A site answered with a non-success status. Carries what you need to decide what to do next:
 * a 401/403 usually means the session expired, 429 means slow down.
 */
export class SiteApiError extends Error {
  override readonly name = 'SiteApiError'
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly method: string
  readonly body: string

  constructor(init: SiteApiErrorInit, options?: { cause?: unknown }) {
    super(`${init.method} ${init.url} failed with ${init.status}${init.statusText
      ? ` ${init.statusText}`
      : ''}`, options)
    this.status = init.status
    this.statusText = init.statusText
    this.url = init.url
    this.method = init.method
    this.body = init.body.length > MAX_BODY_LENGTH
      ? init.body.slice(0, MAX_BODY_LENGTH)
      : init.body
  }

  /** Builds the error from a response, reading (and so consuming) its body. */
  static async fromResponse(response: Response, request?: Request): Promise<SiteApiError> {
    let body = ''
    try {
      body = await response.text()
    }
    catch {
      // The body may already be consumed or the stream may have failed; the status alone still
      // tells the caller what happened.
    }
    return new SiteApiError({
      status: response.status,
      statusText: response.statusText,
      url: response.url || request?.url || '',
      method: request?.method ?? 'GET',
      body,
    })
  }
}

/** True for a {@link SiteApiError}, including one from another copy of this package. */
export function isSiteApiError(value: unknown): value is SiteApiError {
  return value instanceof SiteApiError
    || (value instanceof Error && value.name === 'SiteApiError' && 'status' in value && typeof value.status === 'number')
}
