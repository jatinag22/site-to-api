import type { Browser, BrowserContext, Page, Request, Response } from 'playwright'
import type { FixtureSite } from './server'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import browse from '../scenarios/browse'
import browseAgain from '../scenarios/browse-again'
import login from '../scenarios/login'
import { startFixtureSite } from './server'

const FIXED_NOW = Date.UTC(2026, 9, 28, 9, 30)

const SourceMapSchema = z.object({
  version: z.literal(3),
  sources: z.array(z.string()),
  sourcesContent: z.array(z.string()),
})
const LoginBodySchema = z.object({
  username: z.string(),
  password: z.string(),
})

interface Recorded {
  requests: Request[]
  responses: Response[]
  framesReceived: string[]
  framesSent: string[]
}

/** Records everything the page does so the assertions can look at the traffic. */
function record(page: Page): Recorded {
  const recorded: Recorded = {
    requests: [],
    responses: [],
    framesReceived: [],
    framesSent: [],
  }
  page.on('request', request => recorded.requests.push(request))
  page.on('response', response => recorded.responses.push(response))
  page.on('websocket', (socket) => {
    socket.on('framereceived', frame => recorded.framesReceived.push(String(frame.payload)))
    socket.on('framesent', frame => recorded.framesSent.push(String(frame.payload)))
  })
  return recorded
}

function pathOf(url: string): string {
  return new URL(url).pathname
}

function responsesTo(recorded: Recorded, path: string): Response[] {
  return recorded.responses.filter(response => pathOf(response.url()) === path)
}

/** Gets a valid `_abck` the way the sensor script does, for plain-HTTP checks. */
async function shieldCookie(origin: string): Promise<string> {
  const response = await fetch(`${origin}/shield/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sensor_data: 'test' }),
  })
  expect(response.status).toBe(201)
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('_abck='))
  if (cookie === undefined)
    throw new Error('no _abck cookie')
  return cookie.split(';')[0] ?? ''
}

describe('fixture site over plain HTTP', () => {
  let site: FixtureSite

  beforeAll(async () => {
    site = await startFixtureSite({
      now: () => FIXED_NOW,
    })
  })
  afterAll(async () => {
    await site.close()
  })

  it('serves the main origin on localhost and analytics on 127.0.0.1', () => {
    expect(new URL(site.origin).hostname).toBe('localhost')
    expect(new URL(site.secondaryOrigin).hostname).toBe('127.0.0.1')
  })

  it('answers 403 on every API without a valid _abck cookie', async () => {
    for (const path of [
      '/api/products',
      '/api/categories',
      '/api/export.csv',
      '/api/auth/key',
    ]) {
      const response = await fetch(`${site.origin}${path}`)
      expect(response.status, path).toBe(403)
    }
    const forged = await fetch(`${site.origin}/api/products`, {
      headers: { cookie: '_abck=ABCDEF~0~forged~-1' },
    })
    expect(forged.status).toBe(403)
    const cookie = await shieldCookie(site.origin)
    expect((await fetch(`${site.origin}/api/products`, {
      headers: { cookie },
    })).status).toBe(200)
  })

  it('rejects a sensor post without sensor_data', async () => {
    const response = await fetch(`${site.origin}/shield/collect`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(400)
  })

  it('serves products, details and reviews by numeric id', async () => {
    const cookie = await shieldCookie(site.origin)
    const list = await (await fetch(`${site.origin}/api/products?category=snacks&page=2`, {
      headers: { cookie },
    })).json()
    expect(list).toMatchObject({
      page: 2,
      pageSize: 3,
      total: 6,
      totalPages: 2,
    })
    const detail = await fetch(`${site.origin}/api/products/1007`, {
      headers: { cookie },
    })
    expect(await detail.json()).toMatchObject({ id: 1007, category: 'snacks', sku: 'PM-SNK-1007' })
    const reviews = await (await fetch(`${site.origin}/api/products/1007/reviews`, {
      headers: { cookie },
    })).json()
    expect(reviews).toMatchObject({ productId: 1007 })
    const related = await fetch(`${site.origin}/api/products/1007/related`, {
      headers: { cookie },
    })
    expect(related.status).toBe(200)
    expect((await fetch(`${site.origin}/api/products/9999`, {
      headers: { cookie },
    })).status).toBe(404)
  })

  it('serves the same data for the same seed', async () => {
    const other = await startFixtureSite({
      now: () => FIXED_NOW,
    })
    try {
      const [a, b] = await Promise.all([site.origin, other.origin].map(async (origin) => {
        const cookie = await shieldCookie(origin)
        return (await fetch(`${origin}/api/export.csv`, {
          headers: { cookie },
        })).text()
      }))
      expect(a).toBe(b)
    }
    finally {
      await other.close()
    }
  })

  it('serves different data for a different seed', async () => {
    const other = await startFixtureSite({ seed: 7 })
    try {
      const [a, b] = await Promise.all([site.origin, other.origin].map(async (origin) => {
        const cookie = await shieldCookie(origin)
        return (await fetch(`${origin}/api/export.csv`, {
          headers: { cookie },
        })).text()
      }))
      expect(a).not.toBe(b)
    }
    finally {
      await other.close()
    }
  })

  it('needs the JavaScript-set pm_store cookie for the stock file', async () => {
    const cookie = await shieldCookie(site.origin)
    expect((await fetch(`${site.origin}/api/stock.txt`, {
      headers: { cookie },
    })).status).toBe(400)
    const response = await fetch(`${site.origin}/api/stock.txt`, {
      headers: { cookie: `${cookie}; pm_store=cedar-park` },
    })
    expect(response.headers.get('content-type')).toContain('text/plain')
    const lines = (await response.text()).trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines)
      expect(line).toMatch(/^\d+\|[^|]+\|(?:in-stock|sold-out)\|\d+$/)
  })

  it('renders different deals per page and different details per store', async () => {
    const deals1 = await (await fetch(`${site.origin}/deals?page=1`)).text()
    const deals2 = await (await fetch(`${site.origin}/deals?page=2`)).text()
    expect(deals1).toMatch(/<td class="price">₹[\d,]+\.\d{2}<\/td>/)
    expect(deals1).toMatch(/<td class="discount">\d+%<\/td>/)
    expect(deals1).toMatch(/<a href="\/products\/\d+">/)
    expect(deals1).not.toBe(deals2)
    expect((await fetch(`${site.origin}/deals?page=9`)).status).toBe(404)
    const store = await (await fetch(`${site.origin}/stores/pine-hill`)).text()
    expect(store).toContain('<dt>Address</dt>')
    expect(store).toContain('<span class="label">Parking</span>')
    expect((await fetch(`${site.origin}/stores/nowhere`)).status).toBe(404)
  })

  it('refuses a login without the CSRF header or with a plain-text password', async () => {
    const cookie = await shieldCookie(site.origin)
    const loginPage = await (await fetch(`${site.origin}/login`)).text()
    const csrf = /<meta name="csrf-token" content="([^"]+)">/.exec(loginPage)?.[1]
    expect(csrf).toBeDefined()
    expect(loginPage).toContain(`<input type="hidden" name="_csrf" value="${csrf ?? ''}">`)
    const body = JSON.stringify({ username: 'demo', password: 'demo-password' })
    const headers = { cookie, 'content-type': 'application/json' }
    const noCsrf = await fetch(`${site.origin}/api/auth/login`, { method: 'POST', headers, body })
    expect(noCsrf.status).toBe(403)
    const plain = await fetch(`${site.origin}/api/auth/login`, {
      method: 'POST',
      headers: { ...headers, 'x-csrf-token': csrf ?? '' },
      body,
    })
    expect(plain.status).toBe(400)
  })

  it('answers 401 on account APIs without both the session cookie and the bearer token', async () => {
    const cookie = await shieldCookie(site.origin)
    expect((await fetch(`${site.origin}/api/me`, {
      headers: { cookie },
    })).status).toBe(401)
    expect((await fetch(`${site.origin}/api/orders`, {
      headers: { cookie: `${cookie}; pm_session=abc`, authorization: 'Bearer x.y.z' },
    })).status).toBe(401)
  })

  it('pushes ticks over the WebSocket after a subscribe message', async () => {
    const socket = new WebSocket(`${site.origin.replace('http', 'ws')}/ws/ticker`)
    const ticks = await new Promise<unknown[]>((resolve, reject) => {
      const received: unknown[] = []
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', productId: 1001 })))
      socket.addEventListener('error', () => reject(new Error('socket error')))
      socket.addEventListener('message', (event) => {
        const message: unknown = JSON.parse(String(event.data))
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'tick')
          received.push(message)
        if (received.length === 2)
          resolve(received)
      })
    })
    socket.close()
    expect(ticks).toEqual([
      expect.objectContaining({
        productId: 1001,
        seq: 1,
        at: new Date(FIXED_NOW).toISOString(),
      }),
      expect.objectContaining({ productId: 1001, seq: 2 }),
    ])
  })

  it('serves the app bundle with an external sourcemap that embeds the sources', async () => {
    const home = await (await fetch(site.origin)).text()
    const appPath = /src="(\/assets\/app\.[A-Z0-9]+\.js)"/.exec(home)?.[1]
    expect(appPath).toBeDefined()
    const bundle = await (await fetch(`${site.origin}${appPath ?? ''}`)).text()
    const mapName = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(bundle)?.[1]
    expect(mapName).toMatch(/^app\.[A-Z0-9]+\.js\.map$/)
    const map = SourceMapSchema.parse(await (await fetch(new URL(mapName ?? '', `${site.origin}${appPath ?? ''}`))).json())
    const { sources, sourcesContent } = map
    const index = sources.indexOf('src/auth/crypto.ts')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(sourcesContent[index]).toContain('export async function encryptPassword(')
    // The bundle keeps meaningful function names so stack frames name the site's own functions.
    expect(bundle).toContain('function encryptPassword(')
  })

  it('serves the ticker widget with an inline data: sourcemap and the sensor with none', async () => {
    const ticker = await (await fetch(`${site.origin}/assets/ticker.js`)).text()
    const inline = /\/\/# sourceMappingURL=data:application\/json;base64,(\S+)/.exec(ticker)?.[1]
    expect(inline).toBeDefined()
    const map: unknown = JSON.parse(Buffer.from(inline ?? '', 'base64').toString('utf8'))
    expect(map).toMatchObject({
      sources: ['src/widgets/ticker.ts'],
    })
    const sensor = await (await fetch(`${site.origin}/shield/sensor.js`)).text()
    expect(sensor).not.toContain('sourceMappingURL')
    expect(sensor.trim().split('\n')).toHaveLength(1)
  })

  it('serves static assets with their media types', async () => {
    const expected: Record<string, string> = {
      '/assets/site.css': 'text/css',
      '/assets/logo.png': 'image/png',
      '/assets/fonts/pinewood-sans.woff2': 'font/woff2',
    }
    for (const [path, type] of Object.entries(expected))
      expect((await fetch(`${site.origin}${path}`)).headers.get('content-type'), path).toContain(type)
    expect((await fetch(`${site.secondaryOrigin}/pixel.gif`)).headers.get('content-type')).toBe('image/gif')
  })
})

describe('fixture site in a browser, driven by the capture scenarios', () => {
  let site: FixtureSite
  let browser: Browser
  let context: BrowserContext | undefined

  beforeAll(async () => {
    site = await startFixtureSite({
      now: () => FIXED_NOW,
      livePriceIntervalMs: 500,
      tickIntervalMs: 300,
    })
    browser = await chromium.launch({ headless: true })
  })
  afterEach(async () => {
    await context?.close()
    context = undefined
  })
  afterAll(async () => {
    await browser.close()
    await site.close()
  })

  async function openPage(): Promise<{ page: Page, recorded: Recorded }> {
    context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()
    return {
      page,
      recorded: record(page),
    }
  }

  it('browse: covers every catalogue API, HTML page, text export, WebSocket and noise', async () => {
    const { page, recorded } = await openPage()
    const downloads: string[] = []
    page.on('download', (download) => {
      downloads.push(download.suggestedFilename())
      void download.path().then(async (path) => {
        downloads.push(await readFile(path, 'utf8'))
      })
    })

    await browse({ page, baseUrl: site.origin })

    const apiStatuses = recorded.responses
      .filter(response => pathOf(response.url()).startsWith('/api/'))
      .map(response => response.status())
    expect(apiStatuses.length).toBeGreaterThan(0)
    expect(apiStatuses.every(status => status === 200)).toBe(true)

    for (const path of [
      '/api/categories',
      '/api/products',
      '/api/products/1007',
      '/api/products/1007/reviews',
      '/api/stock.txt',
      '/api/export.csv',
    ])
      expect(responsesTo(recorded, path), path).not.toHaveLength(0)
    expect(responsesTo(recorded, '/api/live-price').length).toBeGreaterThanOrEqual(2)
    expect(recorded.requests.some(request => pathOf(request.url()).endsWith('/related'))).toBe(false)

    const productPages = recorded.requests.filter(request => request.url().includes('/api/products?')).map(request => new URL(request.url()).searchParams.get('page'))
    expect(productPages).toEqual(['1', '2'])
    expect(responsesTo(recorded, '/deals')).toHaveLength(2)
    expect(responsesTo(recorded, '/stores/pine-hill')).toHaveLength(1)
    expect(responsesTo(recorded, '/stores/cedar-park')).toHaveLength(1)

    const collect = responsesTo(recorded, '/shield/collect')[0]
    expect(collect).toBeDefined()
    expect(await collect?.headerValue('set-cookie')).toMatch(/^_abck=/)

    const stockRequest = recorded.requests.find(request => pathOf(request.url()) === '/api/stock.txt')
    expect(await stockRequest?.headerValue('cookie')).toMatch(/pm_store=pine-hill/)

    expect(recorded.framesSent).toContain(JSON.stringify({ type: 'subscribe', productId: 1007 }))
    expect(recorded.framesReceived.filter(frame => frame.includes('"type":"tick"')).length).toBeGreaterThanOrEqual(1)

    const analytics = recorded.requests.filter(request => request.url().startsWith(site.secondaryOrigin))
    expect(analytics.some(request => pathOf(request.url()) === '/collect' && request.method() === 'POST')).toBe(true)
    expect(analytics.some(request => pathOf(request.url()) === '/pixel.gif')).toBe(true)

    for (const asset of [
      '/assets/site.css',
      '/assets/logo.png',
      '/assets/fonts/pinewood-sans.woff2',
      '/assets/ticker.js',
      '/shield/sensor.js',
    ])
      expect(recorded.requests.some(request => pathOf(request.url()) === asset), asset).toBe(true)

    await expect.poll(() => downloads.length).toBe(2)
    expect(downloads[0]).toBe('pinewood-price-list.csv')
    expect(downloads[1]?.split('\n')[0]).toBe('id,sku,name,category,price_inr,in_stock')
  })

  it('browse-again: gives a second sample with a different category, product and stores', async () => {
    const { page, recorded } = await openPage()
    await browseAgain({ page, baseUrl: site.origin })

    const categories = recorded.requests
      .filter(request => request.url().includes('/api/products?'))
      .map(request => new URL(request.url()).searchParams.get('category'))
    expect(new Set(categories)).toEqual(new Set(['beverages']))
    expect(responsesTo(recorded, '/api/products/1014')).toHaveLength(1)
    expect(responsesTo(recorded, '/deals')).toHaveLength(3)
    expect(responsesTo(recorded, '/stores/maple-cross')).toHaveLength(1)
    expect(responsesTo(recorded, '/stores/birch-lane')).toHaveLength(1)
    expect(responsesTo(recorded, '/api/export.csv')).toHaveLength(1)
  })

  it('login: the server decrypts the RSA-OAEP password and the account APIs accept the session', async () => {
    const { page, recorded } = await openPage()
    await login({ page, baseUrl: site.origin })

    const loginRequest = recorded.requests.find(request => pathOf(request.url()) === '/api/auth/login')
    expect(loginRequest).toBeDefined()
    const sent = LoginBodySchema.parse(loginRequest?.postDataJSON())
    expect(sent.username).toBe('demo')
    const { password } = sent
    expect(password).not.toContain('demo-password')
    // RSA-2048 ciphertext is 256 bytes.
    expect(Buffer.from(password, 'base64')).toHaveLength(256)
    expect(await loginRequest?.headerValue('x-csrf-token')).toMatch(/^[0-9a-f]+\.[\w-]+$/)

    const loginResponse = responsesTo(recorded, '/api/auth/login')[0]
    expect(loginResponse?.status()).toBe(200)
    expect(await loginResponse?.headerValue('set-cookie')).toMatch(/^pm_session=[0-9a-f]+; Path=\/; SameSite=Lax; HttpOnly$/)

    for (const path of ['/api/me', '/api/orders']) {
      const request = recorded.requests.find(candidate => pathOf(candidate.url()) === path)
      // The page navigates away right after login, so the login body cannot be read afterwards;
      // the token the page sends here is the one it read from that body.
      expect(await request?.headerValue('authorization'), path).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
      expect(await request?.headerValue('cookie'), path).toMatch(/pm_session=/)
      expect(responsesTo(recorded, path)[0]?.status(), path).toBe(200)
    }
    expect(await page.locator('#orders tbody tr').count()).toBe(3)
  })
})
