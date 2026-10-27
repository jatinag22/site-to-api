import { describe, expect, it } from 'vitest'
import { CookieJar } from './jar'

const T0 = Date.UTC(2026, 0, 1)

function jarAt(time = T0): { jar: CookieJar, clock: { now: number } } {
  const clock = { now: time }
  return {
    jar: new CookieJar({
      now: () => clock.now,
    }),
    clock,
  }
}

describe('cookieJar', () => {
  describe('domain matching', () => {
    it('sends a host-only cookie to exactly the host that set it', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1')
      expect(jar.cookieHeader('https://example.com/')).toBe('a=1')
      expect(jar.cookieHeader('https://www.example.com/')).toBe('')
    })

    it('sends a Domain cookie to the domain and its subdomains', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://www.example.com/', 'a=1; Domain=.Example.com')
      expect(jar.cookieHeader('https://example.com/')).toBe('a=1')
      expect(jar.cookieHeader('https://api.example.com/')).toBe('a=1')
      expect(jar.cookieHeader('https://notexample.com/')).toBe('')
    })

    it('rejects a Domain the host does not belong to', () => {
      const { jar } = jarAt()
      expect(jar.setCookieString('https://example.com/', 'a=1; Domain=other.com')).toBe(false)
      expect(jar.setCookieString('https://example.com/', 'a=1; Domain=sub.example.com')).toBe(false)
      expect(jar.all()).toEqual([])
    })

    it('rejects a single-label Domain such as a top-level domain', () => {
      const { jar } = jarAt()
      expect(jar.setCookieString('https://example.com/', 'a=1; Domain=com')).toBe(false)
    })

    it('does not treat IP addresses as subdomains', () => {
      const { jar } = jarAt()
      jar.set('a', '1', { domain: '0.0.1' })
      expect(jar.cookieHeader('http://127.0.0.1/')).toBe('')
    })
  })

  describe('path matching', () => {
    it('defaults the path to the directory of the request path', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/account/login', 'a=1')
      expect(jar.all()[0]?.path).toBe('/account')
      expect(jar.cookieHeader('https://example.com/account')).toBe('a=1')
      expect(jar.cookieHeader('https://example.com/account/orders')).toBe('a=1')
      expect(jar.cookieHeader('https://example.com/accounts')).toBe('')
      expect(jar.cookieHeader('https://example.com/')).toBe('')
    })

    it('uses "/" when the request path has a single segment', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/login', 'a=1')
      expect(jar.all()[0]?.path).toBe('/')
    })

    it('ignores a Path attribute that does not start with a slash', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/a/b', 'a=1; Path=relative')
      expect(jar.all()[0]?.path).toBe('/a')
    })

    it('orders longer paths first, then older cookies first', () => {
      const { jar, clock } = jarAt()
      jar.setCookieString('https://example.com/', 'root=1; Path=/')
      clock.now += 1
      jar.setCookieString('https://example.com/', 'deep=1; Path=/api')
      clock.now += 1
      jar.setCookieString('https://example.com/', 'later=1; Path=/')
      expect(jar.cookieHeader('https://example.com/api/x')).toBe('deep=1; root=1; later=1')
    })
  })

  describe('expiry', () => {
    it('drops a cookie once Max-Age has passed', () => {
      const { jar, clock } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1; Max-Age=10')
      clock.now += 9_999
      expect(jar.cookieHeader('https://example.com/')).toBe('a=1')
      clock.now += 1
      expect(jar.cookieHeader('https://example.com/')).toBe('')
    })

    it('prefers Max-Age over Expires', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60')
      expect(jar.all()[0]?.expires).toBe(T0 + 60_000)
    })

    it('reads Expires dates that contain a comma', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1; Expires=Fri, 02 Jan 2026 00:00:00 GMT')
      expect(jar.all()[0]?.expires).toBe(Date.UTC(2026, 0, 2))
    })

    it('deletes an existing cookie when Max-Age is zero or the date is past', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1')
      jar.setCookieString('https://example.com/', 'b=1')
      jar.setCookieString('https://example.com/', 'a=; Max-Age=0')
      jar.setCookieString('https://example.com/', 'b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT')
      expect(jar.all()).toEqual([])
    })

    it('keeps session cookies without an expiry', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1')
      expect(jar.all()[0]?.expires).toBeNull()
    })
  })

  describe('secure', () => {
    it('sends Secure cookies over https and loopback only', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1; Secure')
      expect(jar.cookieHeader('https://example.com/')).toBe('a=1')
      expect(jar.cookieHeader('http://example.com/')).toBe('')
      jar.set('b', '2', { domain: 'localhost', secure: true })
      expect(jar.cookieHeader('http://localhost:3000/')).toBe('b=2')
    })
  })

  describe('parsing', () => {
    it('reads flags and SameSite, case-insensitively', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1; HttpOnly; SameSite=LAX; secure')
      expect(jar.all()[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' })
    })

    it('keeps "=" inside the value and quotes as sent', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'token=abc==; Path=/')
      jar.setCookieString('https://example.com/', 'q="x y"')
      expect(jar.cookieHeader('https://example.com/')).toBe('token=abc==; q="x y"')
    })

    it('ignores unknown attributes, including Object.prototype names', () => {
      const { jar } = jarAt()
      expect(jar.setCookieString('https://example.com/', 'a=1; __proto__; constructor=x; SameSite=__proto__; Priority=High')).toBe(true)
      expect(jar.all()[0]).toMatchObject({ name: 'a', sameSite: null })
    })

    it('rejects headers without a name or "="', () => {
      const { jar } = jarAt()
      expect(jar.setCookieString('https://example.com/', 'novalue')).toBe(false)
      expect(jar.setCookieString('https://example.com/', '=1')).toBe(false)
    })

    it('replaces a cookie with the same name, domain and path, keeping its creation time', () => {
      const { jar, clock } = jarAt()
      jar.setCookieString('https://example.com/', 'a=1')
      clock.now += 5
      jar.setCookieString('https://example.com/', 'a=2')
      expect(jar.all()).toHaveLength(1)
      expect(jar.all()[0]).toMatchObject({ value: '2', creation: T0 })
    })
  })

  describe('setFromResponse', () => {
    it('reads every header from getSetCookie()', () => {
      const { jar } = jarAt()
      const headers = new Headers()
      headers.append('set-cookie', 'a=1; Path=/')
      headers.append('set-cookie', 'b=2; Expires=Fri, 02 Jan 2026 00:00:00 GMT')
      jar.setFromResponse('https://example.com/', headers)
      expect(jar.cookieHeader('https://example.com/')).toBe('a=1; b=2')
    })

    it('splits a combined header when getSetCookie is missing', () => {
      const { jar } = jarAt()
      const combined = 'a=1; Expires=Fri, 02 Jan 2026 00:00:00 GMT; Path=/, b=2, c=3; HttpOnly'
      jar.setFromResponse('https://example.com/', {
        get: name => (name === 'set-cookie'
          ? combined
          : null),
      })
      expect(jar.cookieHeader('https://example.com/')).toBe('a=1; b=2; c=3')
    })

    it('does nothing when there is no Set-Cookie header', () => {
      const { jar } = jarAt()
      jar.setFromResponse('https://example.com/', {
        get: () => null,
      })
      expect(jar.all()).toEqual([])
    })
  })

  describe('set', () => {
    it('sets domain and host-only cookies directly', () => {
      const { jar } = jarAt()
      jar.set('a', '1', { domain: '.example.com' })
      jar.set('b', '2', { domain: 'example.com', hostOnly: true, path: '/api' })
      expect(jar.cookieHeader('https://www.example.com/api')).toBe('a=1')
      expect(jar.cookieHeader('https://example.com/api')).toBe('b=2; a=1')
    })

    it('accepts expiry as a Date, a number or maxAge', () => {
      const { jar } = jarAt()
      jar.set('a', '1', {
        domain: 'example.com',
        expires: new Date(T0 + 1000),
      })
      jar.set('b', '1', { domain: 'example.com', expires: T0 + 2000 })
      jar.set('c', '1', { domain: 'example.com', maxAge: 3 })
      jar.set('d', '1', { domain: 'example.com', expires: T0 - 1 })
      expect(jar.all().map(cookie => [cookie.name, cookie.expires])).toEqual([
        ['a', T0 + 1000],
        ['b', T0 + 2000],
        ['c', T0 + 3000],
      ])
    })
  })

  describe('delete and clear', () => {
    it('deletes by name, optionally per domain', () => {
      const { jar } = jarAt()
      jar.set('a', '1', { domain: 'one.com' })
      jar.set('a', '1', { domain: 'two.com' })
      jar.set('b', '1', { domain: 'one.com' })
      jar.delete('a', 'one.com')
      expect(jar.all().map(cookie => `${cookie.domain}:${cookie.name}`)).toEqual(['one.com:b', 'two.com:a'])
      jar.delete('a')
      expect(jar.all()).toHaveLength(1)
      jar.clear()
      expect(jar.all()).toEqual([])
    })
  })

  describe('persistence', () => {
    it('round-trips through JSON and drops cookies that expired meanwhile', () => {
      const { jar } = jarAt()
      jar.setCookieString('https://example.com/', 'keep=1; Max-Age=3600')
      jar.setCookieString('https://example.com/', 'short=1; Max-Age=1')
      const saved: unknown = JSON.parse(JSON.stringify(jar))
      const restored = CookieJar.fromJSON(saved, {
        now: () => T0 + 10_000,
      })
      expect(restored.cookieHeader('https://example.com/')).toBe('keep=1')
    })

    it('throws on data that is not a saved jar', () => {
      expect(() => CookieJar.fromJSON({ version: 2, cookies: [] })).toThrow(TypeError)
      expect(() => CookieJar.fromJSON('nope')).toThrow(/not a saved cookie jar/)
    })
  })
})
