import type { Server } from 'node:http'
import type { Session } from '../session'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CookieJar } from '../cookies'
import { tokenSession } from '../session'
import { createFetch } from './create-fetch'

type Responder = (request: Request, index: number) => Response | Promise<Response>

/** A fetch double that records each request and answers from `respond`. */
function fakeFetch(respond: Responder): { fetch: typeof fetch, requests: Request[] } {
  const requests: Request[] = []
  const double: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    return respond(request, requests.length - 1)
  }
  return { fetch: double, requests }
}

/** Retry options that never wait, recording the delays asked for. */
function instantRetry(delays: number[], extra: { attempts?: number, unsafe?: boolean, now?: () => number } = {}) {
  return {
    random: () => 0.5,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
    ...extra,
  }
}

describe('createFetch', () => {
  describe('cookies', () => {
    it('stores Set-Cookie and sends it on the next request', async () => {
      const jar = new CookieJar()
      const { fetch, requests } = fakeFetch((_, index) => new Response('ok', {
        headers: index === 0
          ? { 'set-cookie': 'sid=abc; Path=/' }
          : {},
      }))
      const client = createFetch({ jar, fetch })
      await client('https://example.com/login')
      await client('https://example.com/me')
      expect(requests[0]?.headers.get('cookie')).toBeNull()
      expect(requests[1]?.headers.get('cookie')).toBe('sid=abc')
    })

    it('keeps cookies between calls without an explicit jar', async () => {
      const { fetch, requests } = fakeFetch((_, index) => new Response('', {
        headers: index === 0
          ? { 'set-cookie': 'a=1' }
          : {},
      }))
      const client = createFetch({ fetch })
      await client('https://example.com/')
      await client('https://example.com/')
      expect(requests[1]?.headers.get('cookie')).toBe('a=1')
    })

    it('lets a Cookie header from the caller win for the same name', async () => {
      const jar = new CookieJar()
      jar.set('a', 'jar', { domain: 'example.com' })
      jar.set('b', 'jar', { domain: 'example.com' })
      const { fetch, requests } = fakeFetch(() => new Response(''))
      await createFetch({ jar, fetch })('https://example.com/', {
        headers: { cookie: 'a=mine' },
      })
      expect(requests[0]?.headers.get('cookie')).toBe('a=mine; b=jar')
    })
  })

  describe('default headers', () => {
    it('adds them unless the request sets the header itself', async () => {
      const { fetch, requests } = fakeFetch(() => new Response(''))
      const client = createFetch({
        fetch,
        defaultHeaders: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'application/json' },
      })
      await client('https://example.com/', {
        headers: { accept: 'text/html' },
      })
      expect(requests[0]?.headers.get('x-requested-with')).toBe('XMLHttpRequest')
      expect(requests[0]?.headers.get('accept')).toBe('text/html')
    })
  })

  describe('retries', () => {
    it('retries retryable statuses with exponential backoff', async () => {
      const delays: number[] = []
      const { fetch, requests } = fakeFetch((_, index) => new Response('', {
        status: index < 2
          ? 503
          : 200,
      }))
      const response = await createFetch({
        fetch,
        retry: {
          ...instantRetry(delays),
          baseDelayMs: 100,
        },
      })('https://example.com/')
      expect(response.status).toBe(200)
      expect(requests).toHaveLength(3)
      // random() = 0.5 puts each delay at three quarters of the doubled base.
      expect(delays).toEqual([75, 150])
    })

    it('returns the last response when attempts run out', async () => {
      const delays: number[] = []
      const { fetch, requests } = fakeFetch(() => new Response('', { status: 429 }))
      const response = await createFetch({
        fetch,
        retry: instantRetry(delays, { attempts: 2 }),
      })('https://example.com/')
      expect(response.status).toBe(429)
      expect(requests).toHaveLength(2)
    })

    it.each([423, 429, 502, 503, 504])('retries status %i by default', async (status) => {
      const { fetch, requests } = fakeFetch((_, index) => new Response('', {
        status: index === 0
          ? status
          : 200,
      }))
      await createFetch({
        fetch,
        retry: instantRetry([]),
      })('https://example.com/')
      expect(requests).toHaveLength(2)
    })

    it('does not retry other errors', async () => {
      const { fetch, requests } = fakeFetch(() => new Response('', { status: 500 }))
      const response = await createFetch({
        fetch,
        retry: instantRetry([]),
      })('https://example.com/')
      expect(response.status).toBe(500)
      expect(requests).toHaveLength(1)
    })

    it('honours Retry-After in seconds and as a date', async () => {
      const delays: number[] = []
      const now = Date.UTC(2026, 0, 1)
      const retryAfter = [
        '2',
        new Date(now + 5000).toUTCString(),
      ]
      const { fetch } = fakeFetch((_, index) => {
        const value = retryAfter[index]
        return value === undefined
          ? new Response('')
          : new Response('', {
              status: 429,
              headers: { 'retry-after': value },
            })
      })
      await createFetch({
        fetch,
        retry: instantRetry(delays, {
          now: () => now,
        }),
      })('https://example.com/')
      expect(delays).toEqual([2000, 5000])
    })

    it('does not wait for a Retry-After longer than maxDelayMs', async () => {
      const { fetch, requests } = fakeFetch(() => new Response('', {
        status: 503,
        headers: { 'retry-after': '3600' },
      }))
      const response = await createFetch({
        fetch,
        retry: instantRetry([]),
      })('https://example.com/')
      expect(response.status).toBe(503)
      expect(requests).toHaveLength(1)
    })

    it('never retries POST unless retry.unsafe is set', async () => {
      const failing = (): ReturnType<typeof fakeFetch> => fakeFetch((_, index) => new Response('', {
        status: index === 0
          ? 503
          : 200,
      }))
      const plain = failing()
      expect((await createFetch({
        fetch: plain.fetch,
        retry: instantRetry([]),
      })('https://example.com/', { method: 'POST', body: 'x' })).status).toBe(503)
      expect(plain.requests).toHaveLength(1)

      const unsafe = failing()
      const response = await createFetch({
        fetch: unsafe.fetch,
        retry: instantRetry([], { unsafe: true }),
      })('https://example.com/', { method: 'POST', body: 'x' })
      expect(response.status).toBe(200)
      expect(await unsafe.requests[1]?.text()).toBe('x')
    })

    it('retries network errors for idempotent methods', async () => {
      const { fetch, requests } = fakeFetch((_, index) => {
        if (index === 0)
          throw new TypeError('fetch failed')
        return new Response('ok')
      })
      const response = await createFetch({
        fetch,
        retry: instantRetry([]),
      })('https://example.com/')
      expect(await response.text()).toBe('ok')
      expect(requests).toHaveLength(2)
    })

    it('rethrows network errors for POST and once attempts run out', async () => {
      const { fetch } = fakeFetch(() => {
        throw new TypeError('fetch failed')
      })
      await expect(createFetch({
        fetch,
        retry: instantRetry([]),
      })('https://example.com/', { method: 'POST' })).rejects.toThrow('fetch failed')
      await expect(createFetch({
        fetch,
        retry: instantRetry([]),
      })('https://example.com/')).rejects.toThrow('fetch failed')
    })

    it('does not retry an aborted request', async () => {
      const controller = new AbortController()
      const { fetch, requests } = fakeFetch(() => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      })
      await expect(createFetch({
        fetch,
        retry: instantRetry([]),
      })('https://example.com/', { signal: controller.signal })).rejects.toThrow('aborted')
      expect(requests).toHaveLength(1)
    })

    it('sends every request once with retry: false', async () => {
      const { fetch, requests } = fakeFetch(() => new Response('', { status: 503 }))
      await createFetch({ fetch, retry: false })('https://example.com/')
      expect(requests).toHaveLength(1)
    })

    it('waits with a real timer by default and stops when aborted', async () => {
      const controller = new AbortController()
      const { fetch } = fakeFetch(() => {
        setTimeout(() => controller.abort(new Error('stop')), 5)
        return new Response('', { status: 503 })
      })
      await expect(createFetch({
        fetch,
        retry: { baseDelayMs: 10_000 },
      })('https://example.com/', { signal: controller.signal })).rejects.toThrow('stop')
    })
  })

  describe('sessions', () => {
    it('applies the session to every request and re-sends once after a refresh', async () => {
      let token = 'old'
      let refreshes = 0
      const session = tokenSession({
        getToken: () => token,
        refresh: () => {
          refreshes += 1
          token = 'new'
        },
      })
      const { fetch, requests } = fakeFetch(request => new Response('', {
        status: request.headers.get('authorization') === 'Bearer new'
          ? 200
          : 401,
      }))
      const response = await createFetch({
        fetch,
        session,
        retry: instantRetry([]),
      })('https://example.com/')
      expect(response.status).toBe(200)
      expect(refreshes).toBe(1)
      expect(requests.map(request => request.headers.get('authorization'))).toEqual(['Bearer old', 'Bearer new'])
    })

    it('asks the session at most once per request', async () => {
      let calls = 0
      const session: Session = {
        prepare: request => request,
        onAuthFailure: () => {
          calls += 1
          return true
        },
      }
      const { fetch, requests } = fakeFetch(() => new Response('', { status: 401 }))
      const response = await createFetch({ fetch, session })('https://example.com/')
      expect(response.status).toBe(401)
      expect(calls).toBe(1)
      expect(requests).toHaveLength(2)
    })

    it('uses the session jar when no jar is given', async () => {
      const jar = new CookieJar()
      jar.set('a', '1', { domain: 'example.com' })
      const session: Session = {
        jar,
        prepare: request => request,
        onAuthFailure: () => false,
      }
      const { fetch, requests } = fakeFetch(() => new Response(''))
      await createFetch({ fetch, session })('https://example.com/')
      expect(requests[0]?.headers.get('cookie')).toBe('a=1')
    })
  })

  describe('hooks', () => {
    it('calls onRequest and onResponse for every network request', async () => {
      const seen: string[] = []
      const { fetch } = fakeFetch((_, index) => new Response('', {
        status: index === 0
          ? 503
          : 200,
      }))
      await createFetch({
        fetch,
        retry: instantRetry([]),
        onRequest: (request) => {
          seen.push(`request ${request.method}`)
        },
        onResponse: (response) => {
          seen.push(`response ${response.status}`)
        },
      })('https://example.com/')
      expect(seen).toEqual([
        'request GET',
        'response 503',
        'request GET',
        'response 200',
      ])
    })
  })

  describe('redirects', () => {
    it('follows redirects itself so cookies set on the way are kept', async () => {
      const { fetch, requests } = fakeFetch((request) => {
        const path = new URL(request.url).pathname
        if (path === '/login') {
          return new Response(null, {
            status: 302,
            headers: { 'location': '/home', 'set-cookie': 'sid=1; Path=/' },
          })
        }
        return new Response('home')
      })
      const response = await createFetch({ fetch })('https://example.com/login', { method: 'POST', body: 'user=x' })
      expect(await response.text()).toBe('home')
      expect(requests.map(request => `${request.method} ${new URL(request.url).pathname} ${request.redirect}`)).toEqual([
        'POST /login manual',
        'GET /home manual',
      ])
      expect(requests[1]?.headers.get('cookie')).toBe('sid=1')
    })

    it('keeps method and body on 307 and drops Authorization across origins', async () => {
      const { fetch, requests } = fakeFetch((request) => {
        if (request.url === 'https://example.com/a') {
          return new Response(null, {
            status: 307,
            headers: { location: 'https://other.example/b' },
          })
        }
        return new Response('done')
      })
      await createFetch({ fetch })('https://example.com/a', {
        method: 'PUT',
        body: 'payload',
        headers: { authorization: 'Bearer t' },
      })
      expect(requests[1]?.method).toBe('PUT')
      expect(await requests[1]?.text()).toBe('payload')
      expect(requests[1]?.headers.get('authorization')).toBeNull()
    })

    it('stops after 20 redirects', async () => {
      const { fetch } = fakeFetch(() => new Response(null, {
        status: 302,
        headers: { location: '/again' },
      }))
      await expect(createFetch({ fetch })('https://example.com/')).rejects.toThrow(/more than 20 redirects/)
    })

    it('leaves redirects to the platform with redirects: native or redirect: manual', async () => {
      const { fetch, requests } = fakeFetch(() => new Response(null, {
        status: 302,
        headers: { location: '/x' },
      }))
      const native = await createFetch({ fetch, redirects: 'native' })('https://example.com/')
      expect(native.status).toBe(302)
      expect(requests[0]?.redirect).toBe('follow')
      const manual = await createFetch({ fetch })('https://example.com/', { redirect: 'manual' })
      expect(manual.status).toBe(302)
      expect(requests).toHaveLength(2)
    })
  })
})

describe('createFetch against a local server', () => {
  let server: Server
  let base = ''
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/login') {
        response.writeHead(303, {
          'location': '/me',
          'set-cookie': ['sid=s1; Path=/; HttpOnly', 'theme=dark; Path=/'],
        })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(request.headers.cookie ?? '')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind to a TCP port')
    base = `http://127.0.0.1:${address.port}`
  })
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('logs in through a redirect and sends both cookies with the platform fetch', async () => {
    const jar = new CookieJar()
    const response = await createFetch({ jar })(`${base}/login`, { method: 'POST', body: 'x' })
    expect(await response.text()).toBe('sid=s1; theme=dark')
    expect(jar.all().map(cookie => cookie.name)).toEqual(['sid', 'theme'])
  })
})
