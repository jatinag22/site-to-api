/** Error raised for problems a user can act on. The message should say what to do next. */
export class SiteToApiError extends Error {
  override readonly name = 'SiteToApiError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}
