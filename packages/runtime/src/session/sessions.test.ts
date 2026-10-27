import type { BrowserCookie } from './sessions'
import { describe, expect, it } from 'vitest'
import { CookieJar } from '../cookies'
import { createFetch } from '../http'
import { browserSession, cookieSession, tokenSession } from './sessions'

const URL_A = 'https://www.example.com/api/data'

function unauthorized(): Response {
  return new Response('', { status: 401 })
}

describe('cookieSession', () => {
  it('exposes the jar and never asks for a retry', async () => {
    const jar = new CookieJar()
    const session = cookieSession(jar)
    const request = new Request(URL_A)
    expect(session.jar).toBe(jar)
    expect(await session.prepare(request)).toBe(request)
    expect(await session.onAuthFailure(unauthorized(), request)).toBe(false)
  })
})

describe('tokenSession', () => {
  it('sends a bearer token in Authorization by default', async () => {
    const session = tokenSession({
      getToken: async () => 't1',
    })
    const request = await session.prepare(new Request(URL_A))
    expect(request.headers.get('authorization')).toBe('Bearer t1')
  })

  it('supports a custom header and a bare token', async () => {
    const session = tokenSession({
      getToken: () => 't1',
      header: 'x-api-key',
      scheme: null,
    })
    const request = await session.prepare(new Request(URL_A))
    expect(request.headers.get('x-api-key')).toBe('t1')
  })

  it('does not retry without a refresh function or on other statuses', async () => {
    const plain = tokenSession({
      getToken: () => 't',
    })
    const request = await plain.prepare(new Request(URL_A))
    expect(await plain.onAuthFailure(unauthorized(), request)).toBe(false)

    const refreshing = tokenSession({
      getToken: () => 't',
      refresh: () => {},
    })
    expect(await refreshing.onAuthFailure(new Response('', { status: 403 }), request)).toBe(false)
  })

  it('shares one refresh between concurrent failures', async () => {
    let token = 'old'
    let refreshes = 0
    const session = tokenSession({
      getToken: () => token,
      refresh: async () => {
        refreshes += 1
        await Promise.resolve()
        token = 'new'
      },
    })
    const fetch: typeof globalThis.fetch = async input => new Request(input).headers.get('authorization') === 'Bearer new'
      ? new Response('ok')
      : unauthorized()
    const client = createFetch({ fetch, session, retry: false })
    const responses = await Promise.all([
      client(URL_A),
      client(URL_A),
      client(URL_A),
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200, 200])
    expect(refreshes).toBe(1)
  })

  it('propagates a failing refresh instead of hiding it', async () => {
    const session = tokenSession({
      getToken: () => 't',
      refresh: async () => {
        throw new Error('refresh token expired')
      },
    })
    const client = createFetch({
      fetch: async () => unauthorized(),
      session,
      retry: false,
    })
    await expect(client(URL_A)).rejects.toThrow('refresh token expired')
  })
})

describe('browserSession', () => {
  const cookies: BrowserCookie[] = [
    {
      name: 'bot',
      value: 'b1',
      domain: '.example.com',
      path: '/',
      expires: -1,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'host',
      value: 'h1',
      domain: 'www.example.com',
      expires: Date.UTC(2030, 0, 1) / 1000,
    },
  ]

  it('bootstraps before the first request and copies browser cookies into the jar', async () => {
    const jar = new CookieJar()
    let runs = 0
    const session = browserSession({
      jar,
      bootstrap: async () => {
        runs += 1
        return cookies
      },
    })
    const seen: Array<string | null> = []
    const client = createFetch({
      session,
      fetch: async (input) => {
        seen.push(new Request(input).headers.get('cookie'))
        return new Response('ok')
      },
    })
    await client(URL_A)
    await client('https://api.example.com/x')
    expect(runs).toBe(1)
    expect(seen).toEqual(['bot=b1; host=h1', 'bot=b1'])
    expect(jar.all().find(cookie => cookie.name === 'bot')).toMatchObject({
      hostOnly: false,
      expires: null,
      sameSite: 'lax',
      httpOnly: true,
    })
    expect(jar.all().find(cookie => cookie.name === 'host')).toMatchObject({
      hostOnly: true,
      expires: Date.UTC(2030, 0, 1),
    })
  })

  it('refreshes on 401/403 and re-sends with the new cookies', async () => {
    const jar = new CookieJar()
    let runs = 0
    const session = browserSession({
      jar,
      bootstrap: async () => {
        runs += 1
        return [
          { name: 'bot', value: `v${runs}`, domain: '.example.com' },
        ]
      },
    })
    const client = createFetch({
      session,
      retry: false,
      fetch: async input => new Request(input).headers.get('cookie') === 'bot=v2'
        ? new Response('ok')
        : new Response('', { status: 403 }),
    })
    const response = await client(URL_A)
    expect(response.status).toBe(200)
    expect(runs).toBe(2)
  })

  it('runs the browser once for concurrent failures and once at most per request', async () => {
    const jar = new CookieJar()
    let runs = 0
    const session = browserSession({
      jar,
      refreshOn: [401],
      bootstrap: async () => {
        runs += 1
        await Promise.resolve()
        return [
          { name: 'bot', value: 'same', domain: '.example.com' },
        ]
      },
    })
    const client = createFetch({
      session,
      retry: false,
      fetch: async () => unauthorized(),
    })
    await session.refresh()
    const responses = await Promise.all([
      client(URL_A),
      client(URL_A),
      client(URL_A),
    ])
    expect(responses.map(response => response.status)).toEqual([401, 401, 401])
    // One initial run plus one shared refresh for the three failures.
    expect(runs).toBe(2)
  })

  it('does not refresh for statuses outside refreshOn', async () => {
    let runs = 0
    const session = browserSession({
      jar: new CookieJar(),
      bootstrap: async () => {
        runs += 1
        return []
      },
    })
    const client = createFetch({
      session,
      retry: false,
      fetch: async () => new Response('', { status: 500 }),
    })
    expect((await client(URL_A)).status).toBe(500)
    expect(runs).toBe(1)
  })

  it('retries the request without another browser run when a newer refresh already finished', async () => {
    const jar = new CookieJar()
    let runs = 0
    const session = browserSession({
      jar,
      bootstrap: async () => {
        runs += 1
        return []
      },
    })
    const request = await session.prepare(new Request(URL_A))
    await session.refresh()
    expect(await session.onAuthFailure(unauthorized(), request)).toBe(true)
    expect(runs).toBe(2)
  })
})
