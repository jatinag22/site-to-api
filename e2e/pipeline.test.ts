/**
 * The whole pipeline against the Pinewood Market fixture: capture three scripted sessions in a
 * real (headless) Chromium, build the handoff folder, probe the live site, then type-check and
 * use the generated client. Every assertion is about output a coding agent would rely on.
 */
import type { Analysis, ResolvedConfig } from '../packages/site-to-api/src'
import type { FixtureSite } from './fixture-site/server'
import { readdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'pathe'
import { chromium } from 'playwright'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../packages/site-to-api/src'
import { buildHandoff } from '../packages/site-to-api/src/build'
import { runCapture } from '../packages/site-to-api/src/capture'
import { probeOperations, writeProbeReport } from '../packages/site-to-api/src/probe'
import { startFixtureSite } from './fixture-site/server'

const here = fileURLToPath(new URL('.', import.meta.url))
const work = join(here, '.output', 'pipeline')
const scenarios = ['browse', 'browse-again', 'login'] as const

let site: FixtureSite
let config: ResolvedConfig
let analysis: Analysis
let outDir: string
let files: Map<string, string>
let host: string

async function readAll(dir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      result.set(relative(dir, path), await readFile(path, 'utf8'))
    }
  }
  return result
}

function operation(method: string, path: string): Analysis['operations'][number] {
  const found = analysis.operations.find(op => op.host === host && op.method === method && op.path === path)
  if (!found)
    throw new Error(`no operation ${method} ${path}; have: ${analysis.operations.map(op => `${op.method} ${op.path}`).join(', ')}`)
  return found
}

beforeAll(async () => {
  await rm(work, { recursive: true, force: true })
  site = await startFixtureSite({ port: 0, livePriceIntervalMs: 500, tickIntervalMs: 300 })
  host = new URL(site.origin).host
  const base = {
    rawDir: join(work, 'raw'),
    outDir: join(work, 'handoff'),
    capture: {
      browser: { channel: null, headless: true },
    },
  }
  for (const scenario of scenarios) {
    const scenarioConfig = ConfigSchema.parse({
      ...base,
      capture: {
        ...base.capture,
        script: join(here, 'scenarios', `${scenario}.ts`),
      },
    })
    await runCapture(scenarioConfig, { url: site.origin, sessionId: scenario, cwd: work })
  }
  config = ConfigSchema.parse(base)
  const result = await buildHandoff({ config, cwd: work })
  analysis = result.analysis
  outDir = result.outDir
  files = await readAll(outDir)
}, 300_000)

afterAll(async () => {
  await site?.close()
})

describe('handoff folder', () => {
  it('writes every documented file', () => {
    for (const name of [
      'AGENT.md',
      'API_MAP.md',
      'flows.json',
      'flows.md',
      'flows.schema.json',
      'client/index.ts',
      'client/README.md',
    ])
      expect(files.has(name), name).toBe(true)
    expect([
      ...files.keys(),
    ].some(name => name.startsWith('specs/') && name.endsWith('.yaml'))).toBe(true)
  })

  it('covers the shop host and leaves the analytics host out', () => {
    expect(analysis.hosts).toContain(host)
    expect(analysis.hosts).not.toContain(new URL(site.secondaryOrigin).host)
  })

  it('never contains captured secrets', () => {
    // Session, bot-protection and auth values. (`pm_store` is a public store slug, not a secret.)
    const SECRET_COOKIES = new Set(['pm_session', '_abck', 'bm_sz'])
    const forbidden = ['demo-password']
    const raw = analysis.operations.flatMap(op => op.exchanges)
    for (const exchange of raw) {
      for (const cookie of exchange.request.cookies) {
        if (SECRET_COOKIES.has(cookie.name))
          forbidden.push(cookie.value)
      }
      const csrf = exchange.request.headers.find(header => header.name === 'x-csrf-token')?.value
      if (csrf)
        forbidden.push(csrf)
      const auth = exchange.request.headers.find(header => header.name === 'authorization')?.value
      if (auth)
        forbidden.push(auth.replace(/^Bearer /i, ''))
    }
    expect(forbidden.length).toBeGreaterThan(3)
    for (const [name, content] of files) {
      for (const secret of new Set(forbidden))
        expect(content.includes(secret), `${name} contains a captured secret`).toBe(false)
    }
  })

  it('is deterministic for the same captures', async () => {
    await buildHandoff({ config, cwd: work })
    const again = await readAll(outDir)
    expect([
      ...again.keys(),
    ].sort()).toEqual([
      ...files.keys(),
    ].sort())
    for (const [name, content] of files)
      expect(again.get(name), name).toBe(content)
  }, 120_000)
})

describe('operations', () => {
  it('turns numeric product ids into a path parameter', () => {
    const detail = operation('GET', '/api/products/{productId}')
    expect(detail.pathParams.map(param => param.name)).toEqual(['productId'])
    expect(operation('GET', '/api/products/{productId}/reviews').exchanges.length).toBeGreaterThan(1)
  })

  it('turns store slugs into a parameter because the store list links to them', () => {
    expect(operation('GET', '/stores/{slug}').exchanges.length).toBe(4)
    expect(analysis.operations.some(op => /^\/stores\/[a-z]+-[a-z]+$/.test(op.path))).toBe(false)
  })

  it('finds the endpoint that only exists in the code', () => {
    const related = analysis.operations.find(op => op.path.endsWith('/related'))
    expect(related?.sourceOnly).toBe(true)
  })

  it('infers record extraction for the server-rendered deals table', () => {
    const deals = operation('GET', '/deals')
    const html = deals.responses.find(response => response.mimeType === 'text/html')
    expect(html?.extract?.spec.kind).toBe('html')
    expect(html?.extract?.confidence).toBe('high')
  })

  it('points requests at the frontend code that sends them', () => {
    const login = operation('POST', '/api/auth/login')
    expect(login.sentFrom[0]?.original).toBe(true)
    expect(login.sentFrom[0]?.file).toMatch(/src\//)
  })
})

describe('flows and session needs', () => {
  it('detects the Akamai-shaped bot protection and says a browser is needed', () => {
    const session = analysis.flows.session.find(entry => entry.host === host)
    expect(session?.botProtection.map(finding => finding.vendor)).toContain('Akamai')
    expect(session?.requires).toBe('browser')
    expect(session?.cookies.find(cookie => cookie.name === '_abck')).toBeDefined()
  })

  it('traces the CSRF token from the login page and the token into Authorization', () => {
    const steps = analysis.flows.flows.flatMap(flow => flow.steps)
    const login = steps.find(step => step.operationId === operation('POST', '/api/auth/login').operationId)
    expect(login?.inputs['header.x-csrf-token']?.kind).toMatch(/html|step/)
    const orders = steps.find(step => step.operationId === operation('GET', '/api/orders').operationId)
    expect(orders?.inputs['header.authorization']?.kind).toBe('step')
  })

  it('reports no gaps for route literals or bot-protection payloads', () => {
    const guide = files.get('AGENT.md') ?? ''
    expect(guide).not.toMatch(/`body\.\/sensor_data` of/)
    expect(guide).not.toMatch(/`path\.\d+` of `getApiStockTxt`/)
  })

  it('reports the script-set store cookie as set by the page, not unknown', () => {
    const session = analysis.flows.session.find(entry => entry.host === host)
    expect(session?.cookies.find(cookie => cookie.name === 'pm_store')?.source).toBe('browser')
  })

  it('names the function that encrypts the password', () => {
    const computed = analysis.flows.computedValues.find(value => value.input === 'body./password')
    expect(computed?.api).toBe('crypto.subtle.encrypt')
    expect(computed?.producedBy?.functionName).toBe('encryptPassword')
    expect(computed?.producedBy?.file).toContain('auth/crypto.ts')
    expect(files.get('AGENT.md')).toContain('encryptPassword')
  })

  it('links the encryption key to the response it came from', () => {
    const computed = analysis.flows.computedValues.find(value => value.input === 'body./password')
    expect(computed?.uses.length).toBeGreaterThan(0)
    expect(files.get('AGENT.md')).toMatch(/uses `body\.\/publicKey` from `getApiAuthKey`/)
  })

  it('reports the code that asked for a request, not the shared fetch wrapper', () => {
    const login = operation('POST', '/api/auth/login')
    expect(login.sentFrom[0]?.functionName).not.toBe('apiFetch')
  })
})

describe('generated client', () => {
  it('type-checks in strict mode', () => {
    const clientFiles = [
      ...files.keys(),
    ].filter(name => name.startsWith('client/') && name.endsWith('.ts')).map(name => join(outDir, name))
    const program = ts.createProgram(clientFiles, {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    expect(diagnostics).toEqual([])
  })

  it('calls the live site through a browser-backed session', async () => {
    const client = await import(join(outDir, 'client', 'index.ts')) as Record<string, unknown>
    const runtime = await import('@site-to-api/runtime')
    const jar = new runtime.CookieJar()
    const session = runtime.browserSession({
      jar,
      bootstrap: async () => {
        const browser = await chromium.launch()
        try {
          const page = await browser.newPage()
          await page.goto(site.origin, { waitUntil: 'networkidle' })
          return await page.context().cookies()
        }
        finally {
          await browser.close()
        }
      },
    })
    await session.refresh()
    const createSiteClient = client.createSiteClient as (options: { host: string, session: unknown, jar: unknown, baseUrl: string }) => { fetch: typeof fetch }
    const { fetch: siteFetch } = createSiteClient({
      host,
      session,
      jar,
      baseUrl: site.origin,
    })
    const response = await siteFetch(`${site.origin}/api/categories`)
    expect(response.status).toBe(200)
  }, 120_000)
})

describe('probe', () => {
  it('confirms against the live site that the shield cookie is required', async () => {
    const report = await probeOperations({
      operations: analysis.operations,
      config: { ...config.probe, maxRps: 10 },
      toolVersion: 'e2e',
    })
    const categories = report.operations.find(result => result.operationId === operation('GET', '/api/categories').operationId)
    expect(categories?.bare).toBe('rejected')
    expect(report.skipped.some(entry => entry.reason.includes('--unsafe-methods'))).toBe(true)
    await writeProbeReport(outDir, report)
    const rebuilt = await buildHandoff({ config, cwd: work })
    expect(rebuilt.analysis.flows.session.find(entry => entry.host === host)?.probed).toBe(true)
  }, 180_000)
})
