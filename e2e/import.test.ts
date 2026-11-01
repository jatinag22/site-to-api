/**
 * `site-to-api import` end to end (decision 0057): browse the Pinewood Market fixture in a plain
 * Playwright Chromium that records a HAR the way DevTools exports one (bodies embedded, WebSocket
 * messages included), import that HAR, build, and check what an agent would rely on.
 */
import type { Analysis } from '../packages/site-to-api/src'
import type { FixtureSite } from './fixture-site/server'
import { readdir, readFile, rm } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../packages/site-to-api/src'
import { buildHandoff } from '../packages/site-to-api/src/build'
import { importHar } from '../packages/site-to-api/src/import'
import { startFixtureSite } from './fixture-site/server'
import browse from './scenarios/browse'

const here = fileURLToPath(new URL('.', import.meta.url))
const work = join(here, '.output', 'import')
const harPath = join(work, 'exported.har')

let site: FixtureSite
let analysis: Analysis
let files: Map<string, string>
let cookieValues: string[]

async function readAll(dir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile())
      result.set(join(entry.parentPath, entry.name).slice(dir.length + 1), await readFile(join(entry.parentPath, entry.name), 'utf8'))
  }
  return result
}

beforeAll(async () => {
  await rm(work, { recursive: true, force: true })
  site = await startFixtureSite({ port: 0, livePriceIntervalMs: 500, tickIntervalMs: 300 })
  // GitHub's Ubuntu runners cannot start Chromium's sandbox; locally it is on (decision 0047).
  const browser = await chromium.launch({ chromiumSandbox: process.env.CI !== 'true' })
  const context = await browser.newContext({
    recordHar: { path: harPath, content: 'embed', mode: 'full' },
  })
  const page = await context.newPage()
  await browse({ page, baseUrl: site.origin })
  // Session and bot-protection values; `pm_store` is a public store slug, as in the pipeline test.
  cookieValues = (await context.cookies()).filter(cookie => cookie.name !== 'pm_store').map(cookie => cookie.value).filter(value => value.length >= 8)
  await context.close()
  await browser.close()

  const config = ConfigSchema.parse({
    rawDir: join(work, 'raw'),
    outDir: join(work, 'handoff'),
  })
  const imported = await importHar(config, { file: harPath, cwd: work, sessionId: 'exported' })
  expect(imported.meta.source).toBe('har-import')
  const result = await buildHandoff({ config, cwd: work })
  analysis = result.analysis
  files = await readAll(result.outDir)
}, 180_000)

afterAll(async () => {
  await site?.close()
})

describe('an imported DevTools-style HAR', () => {
  it('builds the same kind of API documentation as a capture', () => {
    const paths = analysis.operations.filter(operation => operation.kind === 'api' && !operation.sourceOnly).map(operation => `${operation.method} ${operation.path}`)
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringMatching(/^GET \/api\/products/),
    ]))
    expect(files.has('AGENT.md')).toBe(true)
    expect(files.has('flows.json')).toBe(true)
    expect([
      ...files.keys(),
    ].some(name => name.startsWith('specs/') && name.endsWith('.yaml'))).toBe(true)
  })

  it('says in AGENT.md which parts are missing because the session was imported', () => {
    const guide = files.get('AGENT.md') ?? ''
    expect(guide).toContain('## Imported sessions')
    expect(guide).toContain('imported from a HAR file, not captured: `exported`')
    expect(guide).toContain('No value is shown as computed in the browser')
  })

  it('turns the HAR\'s WebSocket messages into a channel', () => {
    const ticker = (analysis.channels ?? []).find(channel => channel.path === '/ws/ticker')
    expect(ticker?.messages.some(message => message.direction === 'receive')).toBe(true)
  })

  it('redacts the HAR\'s cookies like a capture\'s: none of their values is in the handoff folder', () => {
    const all = [
      ...files.values(),
    ].join('\n')
    expect(cookieValues.length).toBeGreaterThan(0)
    for (const value of cookieValues)
      expect(all.includes(value)).toBe(false)
  })
})
