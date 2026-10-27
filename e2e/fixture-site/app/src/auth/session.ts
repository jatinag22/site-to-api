/** Keeps the bearer token for the tab. The session cookie itself is HttpOnly. */

const TOKEN_KEY = 'pm_access_token'

export function saveAccessToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token)
}

/** Authorization header for account APIs, or `null` when the person has not signed in. */
export function authorizationHeader(): Record<string, string> | null {
  const token = sessionStorage.getItem(TOKEN_KEY)
  return token === null
    ? null
    : { authorization: `Bearer ${token}` }
}
