/**
 * Real headless captures (bundled Chromium) against a local `node:http` site whose script ends
 * the browser itself, the two ways it can go before capture closes it: the context closed after
 * Playwright wrote the HAR (complete), or the browser process ended with no HAR (incomplete).
 */
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema'
import { runCapture } from './index'

let origin: string
let work: string
const server = createServer((req, res) => {
  if (req.url === '/api/items') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Shop</title><script>fetch("/api/items")</script>')
})

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  work = await mkdtemp(path.join(tmpdir(), 'site-to-api-close-'))
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
})

function config(script: string): ReturnType<typeof ConfigSchema.parse> {
  return ConfigSchema.parse({
    capture: {
      browser: { channel: null, headless: true, sandbox: process.env.CI !== 'true' },
      script,
    },
  })
}

describe('runCapture when the browser is gone before capture closes it', () => {
  it('keeps the session complete when the context had closed and the HAR is there', async () => {
    await writeFile(path.join(work, 'closes.mjs'), `
export default async ({ page, context, baseUrl }) => {
  // Listening before the navigation: the page's fetch can finish before goto returns.
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/items')), page.goto(baseUrl)])
  await context.close()
}
`)
    const result = await runCapture(config('closes.mjs'), {
      url: `${origin}/`,
      sessionId: 'closed',
      cwd: work,
      timeouts: { settleMs: 3_000, closeMs: 5_000 },
    })
    expect(result.meta.incomplete).toBeUndefined()
    expect(await readFile(path.join(result.sessionDir, 'traffic.har'), 'utf8')).toContain('/api/items')
  }, 60_000)

  it('takes a close through page.context() for the script\'s own end, not a crash', async () => {
    await writeFile(path.join(work, 'page-context.mjs'), `
export default async ({ page, baseUrl }) => {
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/items')), page.goto(baseUrl)])
  await page.context().close()
}
`)
    const result = await runCapture(config('page-context.mjs'), {
      url: `${origin}/`,
      sessionId: 'page-context',
      cwd: work,
      timeouts: { settleMs: 3_000, closeMs: 5_000 },
    })
    expect(result.meta.incomplete).toBeUndefined()
    expect(await readFile(path.join(result.sessionDir, 'traffic.har'), 'utf8')).toContain('/api/items')
  }, 60_000)

  it('marks the session incomplete when the browser process ended and left no HAR', async () => {
    await writeFile(path.join(work, 'kills.mjs'), `
export default async ({ page, context, baseUrl }) => {
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/items')), page.goto(baseUrl)])
  // Waits for the browser to be gone, however long a slow machine takes, instead of a fixed sleep.
  const gone = new Promise(resolve => context.once('close', resolve))
  const cdp = await context.newCDPSession(page)
  await cdp.send('Browser.close').catch(() => {})
  await gone
  // A script still working on the dead browser fails; that failure is the browser's exit.
  await page.title()
}
`)
    const result = await runCapture(config('kills.mjs'), {
      url: `${origin}/`,
      sessionId: 'killed',
      cwd: work,
      timeouts: { settleMs: 3_000, closeMs: 5_000 },
    })
    expect(result.meta.incomplete).toEqual({ reason: 'error', error: 'the browser exited during the capture' })
    expect(result.warnings.some(warning => warning.includes('already closed when the capture closed it'))).toBe(false)
  }, 60_000)
})
