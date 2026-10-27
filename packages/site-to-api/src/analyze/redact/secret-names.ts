/**
 * Which names carry secrets. Names are split into words (`x-csrf-token`, `accessToken`,
 * `session_id` → words) so `author` or `pincode` do not count while `authToken` does.
 */

/** Headers whose values are always credentials, even when identical across sessions. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
])

const SECRET_WORDS = new Set([
  'token',
  'tokens',
  'secret',
  'password',
  'passwd',
  'pwd',
  'passcode',
  'otp',
  'auth',
  'authorization',
  'authenticity',
  'session',
  'sessionid',
  'sid',
  'ssid',
  'csrf',
  'xsrf',
  'csrftoken',
  'xsrftoken',
  'apikey',
  'signature',
  'sig',
  'credential',
  'credentials',
  'bearer',
  'jwt',
  'refresh',
  'nonce',
  'captcha',
])

/**
 * Words that are secrets only in URLs and forms, where OAuth and SSO put one-time credentials
 * (`?code=`, `?ticket=`, `?key=`). In JSON bodies they are too often ordinary data.
 */
const QUERY_SECRET_WORDS = new Set([
  'code',
  'ticket',
  'key',
  'samlresponse',
  'assertion',
])

const SECRET_JOINED = [
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'csrfmiddlewaretoken',
]

/** Lower-case words of a name: `x-csrf-token` → `[x, csrf, token]`, `accessToken` → `[access, token]`. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word !== '')
}

/**
 * True when a header, field, parameter or cookie name looks like it holds a secret. `inQuery`
 * adds the URL-only words such as `code`.
 */
export function isSecretName(name: string | null | undefined, inQuery = false): boolean {
  if (name === null || name === undefined || name === '')
    return false
  const parts = nameWords(name)
  if (parts.some(part => SECRET_WORDS.has(part) || (inQuery && QUERY_SECRET_WORDS.has(part))))
    return true
  const joined = parts.join('')
  return SECRET_JOINED.some(word => joined.includes(word))
}
