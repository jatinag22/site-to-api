/**
 * A cookie jar implementing the subset of RFC 6265 that HTTP clients need: host-only and domain
 * cookies, path matching, `Expires`/`Max-Age`, `Secure`, replacement by (name, domain, path) and
 * JSON persistence. Written without Node APIs so generated clients run on edge runtimes too.
 *
 * Not implemented: the public suffix list (a `Domain=co.uk` cookie is only rejected when it has
 * no dot), `SameSite` enforcement (there is no browsing context outside a browser) and the
 * `__Host-`/`__Secure-` prefix rules.
 */
import * as z from 'zod/mini'

/** One stored cookie. Times are milliseconds since the epoch. */
export interface Cookie {
  name: string
  value: string
  /** Lower-case domain without a leading dot. */
  domain: string
  /** True when the cookie had no `Domain` attribute: it is sent to exactly `domain`. */
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'strict' | 'lax' | 'none' | null
  /** `null` for a session cookie. */
  expires: number | null
  creation: number
}

/** Options for {@link CookieJar.set}. */
export interface SetCookieOptions {
  /** Domain the cookie belongs to. A leading dot is ignored. */
  domain: string
  /** Send only to `domain` itself, not its subdomains. Defaults to `false`. */
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'strict' | 'lax' | 'none' | null
  /** Absolute expiry as a `Date` or milliseconds since the epoch. */
  expires?: Date | number | null
  /** Lifetime in seconds from now; takes precedence over `expires`, as in RFC 6265. */
  maxAge?: number
}

/** Anything with `Headers`-like access to `Set-Cookie`. */
export interface SetCookieSource {
  get: (name: string) => string | null
  getSetCookie?: () => string[]
}

const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  hostOnly: z.boolean(),
  path: z.string(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.nullable(z.enum(['strict', 'lax', 'none'])),
  expires: z.nullable(z.number()),
  creation: z.number(),
})

const SerializedJarSchema = z.object({
  version: z.literal(1),
  cookies: z.array(CookieSchema),
})

/** The persisted form of a {@link CookieJar}, from `toJSON()`. */
export type SerializedCookieJar = z.infer<typeof SerializedJarSchema>

/** Options for the {@link CookieJar} constructor. */
export interface CookieJarOptions {
  /** Clock used for expiry, injectable for tests. Defaults to `Date.now`. */
  now?: () => number
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
// Maps, not object literals, so attribute names such as `__proto__` cannot reach Object.prototype.
const SAME_SITE = new Map<string, 'strict' | 'lax' | 'none'>([
  ['strict', 'strict'],
  ['lax', 'lax'],
  ['none', 'none'],
])

/**
 * Stores cookies from responses and produces the `Cookie` header for requests.
 *
 * ```ts
 * const jar = new CookieJar()
 * jar.setFromResponse(response.url, response.headers)
 * const header = jar.cookieHeader('https://example.com/api') // "a=1; b=2"
 * ```
 */
export class CookieJar {
  private readonly store = new Map<string, Cookie>()
  private readonly now: () => number

  constructor(options: CookieJarOptions = {}) {
    this.now = options.now ?? Date.now
  }

  /** Restores a jar saved with `toJSON()`. Throws when the data has the wrong shape. */
  static fromJSON(data: unknown, options: CookieJarOptions = {}): CookieJar {
    const parsed = SerializedJarSchema.safeParse(data)
    if (!parsed.success)
      throw new TypeError(`CookieJar.fromJSON: not a saved cookie jar (${parsed.error.message})`)
    const jar = new CookieJar(options)
    for (const cookie of parsed.data.cookies)
      jar.store.set(keyOf(cookie), { ...cookie })
    jar.purgeExpired()
    return jar
  }

  /** Sets a cookie directly, e.g. one copied from a browser. A past expiry deletes it. */
  set(name: string, value: string, options: SetCookieOptions): void {
    const now = this.now()
    const domain = normalizeDomain(options.domain)
    const expires = options.maxAge !== undefined
      ? now + options.maxAge * 1000
      : options.expires instanceof Date
        ? options.expires.getTime()
        : options.expires ?? null
    this.put({
      name,
      value,
      domain,
      hostOnly: options.hostOnly ?? false,
      path: options.path ?? '/',
      secure: options.secure ?? false,
      httpOnly: options.httpOnly ?? false,
      sameSite: options.sameSite ?? null,
      expires,
      creation: now,
    })
  }

  /**
   * Stores every `Set-Cookie` header of a response received from `url`. Uses
   * `headers.getSetCookie()` where available and otherwise splits the combined header.
   */
  setFromResponse(url: string | URL, headers: SetCookieSource): void {
    for (const header of readSetCookie(headers))
      this.setCookieString(url, header)
  }

  /**
   * Parses one `Set-Cookie` header value received from `url` and stores it.
   * Returns false when the cookie was rejected (malformed, or a `Domain` the URL cannot set).
   */
  setCookieString(url: string | URL, header: string): boolean {
    const target = new URL(url)
    const cookie = parseSetCookie(header, target, this.now())
    if (!cookie)
      return false
    this.put(cookie)
    return true
  }

  /**
   * The cookies to send to `url`, ordered as RFC 6265 recommends: longer paths first, then
   * older cookies first.
   */
  cookies(url: string | URL): Cookie[] {
    this.purgeExpired()
    const target = new URL(url)
    const host = target.hostname.toLowerCase()
    const path = target.pathname || '/'
    const secureChannel = isSecureChannel(target)
    const matches: Cookie[] = []
    for (const cookie of this.store.values()) {
      const hostMatches = cookie.hostOnly
        ? host === cookie.domain
        : domainMatches(host, cookie.domain)
      if (hostMatches && pathMatches(path, cookie.path) && (!cookie.secure || secureChannel))
        matches.push(cookie)
    }
    return matches.sort((a, b) => b.path.length - a.path.length || a.creation - b.creation)
  }

  /** The `Cookie` header value for `url`, or an empty string when no cookie applies. */
  cookieHeader(url: string | URL): string {
    return this.cookies(url).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }

  /** Every stored, unexpired cookie, in a stable order. */
  all(): Cookie[] {
    this.purgeExpired()
    return [
      ...this.store.values(),
    ].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  }

  /** Removes cookies by name, optionally only for one domain. */
  delete(name: string, domain?: string): void {
    const wanted = domain === undefined
      ? null
      : normalizeDomain(domain)
    for (const [key, cookie] of this.store) {
      if (cookie.name === name && (wanted === null || cookie.domain === wanted))
        this.store.delete(key)
    }
  }

  /** Removes every cookie. */
  clear(): void {
    this.store.clear()
  }

  /** Persistable form. Session cookies are included; drop them yourself if you need to. */
  toJSON(): SerializedCookieJar {
    return {
      version: 1,
      cookies: this.all().map(cookie => ({ ...cookie })),
    }
  }

  private put(cookie: Cookie): void {
    const key = keyOf(cookie)
    const existing = this.store.get(key)
    if (cookie.expires !== null && cookie.expires <= this.now()) {
      this.store.delete(key)
      return
    }
    // RFC 6265 5.3 step 11: a replaced cookie keeps its original creation time.
    this.store.set(key, existing
      ? { ...cookie, creation: existing.creation }
      : cookie)
  }

  private purgeExpired(): void {
    const now = this.now()
    for (const [key, cookie] of this.store) {
      if (cookie.expires !== null && cookie.expires <= now)
        this.store.delete(key)
    }
  }
}

function keyOf(cookie: Pick<Cookie, 'name' | 'domain' | 'path'>): string {
  return `${cookie.domain};${cookie.path};${cookie.name}`
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^\./, '').toLowerCase()
}

/** Browsers treat loopback hosts as secure contexts, so `Secure` cookies work in local dev. */
function isSecureChannel(url: URL): boolean {
  if (url.protocol === 'https:' || url.protocol === 'wss:')
    return true
  const host = url.hostname
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
}

/** RFC 6265 5.1.3. */
function domainMatches(host: string, domain: string): boolean {
  if (host === domain)
    return true
  return host.endsWith(`.${domain}`) && !IPV4.test(host) && !host.startsWith('[')
}

/** RFC 6265 5.1.4. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath)
    return true
  if (!requestPath.startsWith(cookiePath))
    return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

/** RFC 6265 5.1.4 default-path. */
function defaultPath(url: URL): string {
  const path = url.pathname
  if (!path.startsWith('/'))
    return '/'
  const lastSlash = path.lastIndexOf('/')
  return lastSlash <= 0
    ? '/'
    : path.slice(0, lastSlash)
}

function readSetCookie(headers: SetCookieSource): string[] {
  if (typeof headers.getSetCookie === 'function')
    return headers.getSetCookie()
  const combined = headers.get('set-cookie')
  if (!combined)
    return []
  // Commas also appear inside `Expires=Wed, 21 Oct 2015 ...`; split only where a new `name=`
  // follows, which a date never looks like.
  return combined.split(/,(?=\s*[^;,\s=]+=)/).map(part => part.trim()).filter(Boolean)
}

interface CookieAttributes {
  domain: string | null
  path: string | null
  expires: number | null
  maxAge: number | null
  secure: boolean
  httpOnly: boolean
  sameSite: Cookie['sameSite']
}

/** RFC 6265 5.2, returning null for a cookie the user agent must ignore. */
function parseSetCookie(header: string, url: URL, now: number): Cookie | null {
  const [pair = '', ...attributes] = header.split(';')
  const eq = pair.indexOf('=')
  const name = eq < 0
    ? ''
    : pair.slice(0, eq).trim()
  if (!name)
    return null
  // Quotes stay part of the value (RFC 6265 5.2): servers expect them back verbatim.
  const value = pair.slice(eq + 1).trim()
  const parsed = parseAttributes(attributes)
  const scope = resolveDomain(url.hostname.toLowerCase(), parsed.domain)
  if (!scope)
    return null
  let expires = parsed.expires
  if (parsed.maxAge !== null) {
    expires = parsed.maxAge <= 0
      ? 0
      : now + parsed.maxAge * 1000
  }
  return {
    name,
    value,
    ...scope,
    path: parsed.path ?? defaultPath(url),
    secure: parsed.secure,
    httpOnly: parsed.httpOnly,
    sameSite: parsed.sameSite,
    expires,
    creation: now,
  }
}

/** One reader per attribute name; attributes not listed here are ignored, as RFC 6265 asks. */
const ATTRIBUTE_READERS = new Map<string, (result: CookieAttributes, raw: string) => void>([
  [
    'domain',
    (result, raw) => {
      if (raw)
        result.domain = normalizeDomain(raw)
    },
  ],
  [
    'path',
    (result, raw) => {
      result.path = raw.startsWith('/')
        ? raw
        : null
    },
  ],
  [
    'expires',
    (result, raw) => {
      const time = Date.parse(raw)
      if (!Number.isNaN(time))
        result.expires = time
    },
  ],
  [
    'max-age',
    (result, raw) => {
      if (/^-?\d+$/.test(raw))
        result.maxAge = Number(raw)
    },
  ],
  [
    'secure',
    (result) => {
      result.secure = true
    },
  ],
  [
    'httponly',
    (result) => {
      result.httpOnly = true
    },
  ],
  [
    'samesite',
    (result, raw) => {
      result.sameSite = SAME_SITE.get(raw.toLowerCase()) ?? null
    },
  ],
])

function parseAttributes(attributes: string[]): CookieAttributes {
  const result: CookieAttributes = {
    domain: null,
    path: null,
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
  }
  for (const attribute of attributes) {
    const at = attribute.indexOf('=')
    const key = (at < 0
      ? attribute
      : attribute.slice(0, at)).trim().toLowerCase()
    ATTRIBUTE_READERS.get(key)?.(result, at < 0
      ? ''
      : attribute.slice(at + 1).trim())
  }
  return result
}

/** Where a cookie applies, or null when `host` may not set a cookie for `domain`. */
function resolveDomain(host: string, domain: string | null): { domain: string, hostOnly: boolean } | null {
  if (domain === null)
    return { domain: host, hostOnly: true }
  if (domain === host)
    return { domain, hostOnly: false }
  // A host cannot set cookies for unrelated domains, for a single-label suffix such as `com`,
  // or as an IP address for anything but itself.
  if (!domainMatches(host, domain) || !domain.includes('.'))
    return null
  return { domain, hostOnly: false }
}
