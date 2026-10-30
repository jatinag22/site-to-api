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
  'pass',
  'pwd',
  'passcode',
  'pin',
  'otp',
  'totp',
  'mfa',
  '2fa',
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
  // Captcha and challenge answers: `g-recaptcha-response`, `cf-turnstile-response`.
  'recaptcha',
  'hcaptcha',
  'turnstile',
])

/** Cloudflare challenge tokens in URLs: `__cf_chl_tk`, `__cf_chl_rt_tk`, `__cf_chl_f_tk`. */
const CHALLENGE_TOKEN_NAME = /^__cf_chl_/i

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

/**
 * Whole query parameter names that carry tokens in URLs: Twitch's `?t=<session token>` in a
 * WebSocket recovery URL. Matched as the whole name, never as a word (`x-t-id`), and never when
 * the value is a time (`t=1700000000`, `t=30s`), see {@link isPublicValue}.
 */
const QUERY_SECRET_NAMES = new Set([
  't',
])

/**
 * A Unix time in seconds or milliseconds (10 or 13 digits) or a short offset with units
 * (`90s`, `1m30s`, `1h2m3s`): a time, not a token. Other digit strings (`84736251908374`) can be
 * numeric tokens and stay secret.
 */
const TIME_VALUE = /^(?:\d{10}|\d{13}|(?=\d)(?:\d{1,2}h)?(?:\d{1,3}m)?(?:\d{1,5}s)?)$/

const SECRET_JOINED = [
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'csrfmiddlewaretoken',
  'twofactor',
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
  if (CHALLENGE_TOKEN_NAME.test(name) || (inQuery && QUERY_SECRET_NAMES.has(name.toLowerCase())))
    return true
  const parts = nameWords(name)
  if (parts.some(part => SECRET_WORDS.has(part) || (inQuery && QUERY_SECRET_WORDS.has(part))))
    return true
  const joined = parts.join('')
  return SECRET_JOINED.some(word => joined.includes(word))
}

/** Auth scheme names (RFC 7235 and common practice). Public words, never credentials. */
const AUTH_SCHEMES: ReadonlySet<string> = new Set([
  'bearer',
  'basic',
  'token',
  'jwt',
  'mac',
  'digest',
  'negotiate',
])

/**
 * True when a value is only an auth scheme word (`Bearer`, `Basic`, `Token`, `JWT`, `MAC`,
 * `Digest`, `Negotiate`), as in `tokenType: "Bearer"`. Such a value is not a secret even under a
 * secret-looking name.
 */
export function isAuthScheme(value: string): boolean {
  return AUTH_SCHEMES.has(value.trim().toLowerCase())
}

/**
 * True when a value under a secret-looking name is still public: an auth scheme word
 * ({@link isAuthScheme}), or a time under the short query name `t` (`?t=1700000000`, a video
 * offset `?t=1m30s`).
 */
export function isPublicValue(name: string | null | undefined, value: string): boolean {
  return isAuthScheme(value) || (name?.toLowerCase() === 't' && TIME_VALUE.test(value))
}

/** Joined name words of keys a page embeds for everyone: `x-api-key`, `publishableKey`, `siteKey`. */
const PUBLISHABLE_JOINED = [
  'apikey',
  'publishablekey',
  'publishable',
  'sitekey',
  'clientid',
  'appid',
  'appkey',
  'publickey',
]

/** Words that make any name a credential, even next to `api key` (`apiKeySecret`). */
const NEVER_PUBLISHABLE_WORDS = new Set([
  'secret',
  'private',
  'password',
  'passwd',
  'pass',
  'pwd',
  'passcode',
  'pin',
  'otp',
  'totp',
  'mfa',
  '2fa',
  'session',
  'sessionid',
  'sid',
  'access',
  'refresh',
  'token',
  'tokens',
  'bearer',
  'jwt',
  'credential',
  'credentials',
])

/**
 * True for names of publishable keys: values a page embeds publicly for every visitor (an API
 * key, a client id, a publishable or site key, and `key` in a query string). Only these may be
 * kept when identical across sessions (decision 0015). Every other secret name (a password, OTP,
 * session id, access or refresh token, CSRF token, private key, client secret) is a credential
 * input or a per-person value: identical in two captures means the same person typed or held
 * it twice, not that it is public, so it is always redacted.
 */
export function isPublishableKeyName(name: string | null | undefined, inQuery = false): boolean {
  if (name === null || name === undefined || name === '')
    return false
  const parts = nameWords(name)
  if (parts.some(part => NEVER_PUBLISHABLE_WORDS.has(part)))
    return false
  const joined = parts.join('')
  if (joined.includes('privatekey') || joined.includes('clientsecret'))
    return false
  return PUBLISHABLE_JOINED.some(word => joined.includes(word)) || (inQuery && parts.includes('key'))
}
