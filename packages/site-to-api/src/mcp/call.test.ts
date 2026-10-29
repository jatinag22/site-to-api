import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { HandoffHost } from './handoff'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { shopFlows, writeShopHandoff } from '../../test/handoff'
import { generateClient } from '../gen'
import { cookiePairs, createCaller, credentialNames } from './call'
import { findOperation } from './catalog'
import { loadHandoff } from './handoff'

function host(identifier: string): HandoffHost {
  return {
    file: 'x.yaml',
    host: 'x',
    identifier,
    baseUrl: 'https://x',
    asyncApiFile: null,
    auth: [],
  }
}

describe('credentials', () => {
  it('reads the plain variable only when the folder has one host', () => {
    expect(credentialNames(host('shop_example_com'), 1, 'COOKIE')).toEqual(['SITE_API_COOKIE_SHOP_EXAMPLE_COM', 'SITE_API_COOKIE'])
    expect(credentialNames(host('shop_example_com'), 2, 'AUTH')).toEqual(['SITE_API_AUTH_SHOP_EXAMPLE_COM'])
  })

  it('splits a Cookie header into pairs', () => {
    expect(cookiePairs(' a=1; b=two=2 ;; =x; c')).toEqual(['a=1', 'b=two=2'])
  })
})

describe('createCaller', () => {
  let dir = ''
  let server: Server
  const seen: Array<{ url: string, cookie: string | undefined, auth: string | undefined }> = []

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      seen.push({ url: request.url ?? '', cookie: request.headers.cookie, auth: request.headers.authorization })
      if (request.url?.startsWith('/api/products/') === true) {
        response.writeHead(request.url.endsWith('/404')
          ? 404
          : 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: '1007', name: 'Tea', examples: [] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<html>${'x'.repeat(60_000)}</html>`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind to a TCP port')
    dir = await writeShopHandoff({ serverUrl: `http://127.0.0.1:${address.port}` })
    await generateClient({ handoffDir: dir, flows: shopFlows })
  }, 60_000)

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })

  it('sends through the generated client with credentials from the environment, rate limited', async () => {
    const handoff = await loadHandoff(dir)
    const waits: number[] = []
    let clock = 0
    const call = createCaller({
      handoff,
      maxRps: 2,
      timeoutMs: 5_000,
      env: { SITE_API_COOKIE: 'session=s-1; theme=dark', SITE_API_AUTH: 'Bearer t-1' },
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    const product = findOperation(handoff.operations, 'getApiProductsByProductId')
    const login = findOperation(handoff.operations, 'getLogin')
    if (typeof product === 'string' || typeof login === 'string')
      throw new TypeError('fixture operations missing')
    seen.length = 0
    expect(await call(product, {
      path: { productId: '1007' },
    })).toEqual({
      status: 200,
      ok: true,
      contentType: 'application/json',
      data: { id: '1007', name: 'Tea', examples: [] },
    })
    const page = await call(login, {})
    expect(page).toMatchObject({ status: 200, ok: true, truncated: true })
    expect(typeof page.data === 'string' && page.data.length).toBe(50_001)
    expect(seen.map(request => request.url)).toEqual(['/api/products/1007', '/login'])
    expect(seen[0]?.cookie).toBe('session=s-1; theme=dark')
    // 2 requests per second: the second waits half a second.
    expect(waits).toEqual([500])
    clock = 10_000
    // An HTTP error is a failed call with its status, sent once (no retries).
    seen.length = 0
    expect(await call(product, {
      path: { productId: '404' },
    })).toMatchObject({ status: 404, ok: false })
    expect(seen).toHaveLength(1)
  })

  it('sends no credentials when none are set, and reports a request the client rejects', async () => {
    const handoff = await loadHandoff(dir)
    const call = createCaller({
      handoff,
      maxRps: 10,
      timeoutMs: 5_000,
      env: {},
    })
    const product = findOperation(handoff.operations, 'getApiProductsByProductId')
    if (typeof product === 'string')
      throw new TypeError(product)
    seen.length = 0
    await call(product, {
      path: { productId: '1007' },
    })
    expect(seen[0]?.cookie).toBeUndefined()
    // The generated request schema wants a string path parameter; nothing is sent.
    seen.length = 0
    expect(await call(product, {
      path: { productId: 1007 },
    })).toMatchObject({
      status: null,
      ok: false,
      error: expect.stringContaining('expected string'),
    })
    expect(seen).toEqual([])
  })
})
