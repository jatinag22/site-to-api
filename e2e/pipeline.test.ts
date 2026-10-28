/**
 * The whole pipeline against the Pinewood Market fixture: capture three scripted sessions in a
 * real (headless) Chromium, build the handoff folder, probe the live site, then type-check and
 * use the generated client. Every assertion is about output a coding agent would rely on.
 */
import type { Analysis, ResolvedConfig } from '../packages/site-to-api/src'
import type { FixtureSite } from './fixture-site/server'
import { existsSync } from 'node:fs'
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'pathe'
import { chromium } from 'playwright'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../packages/site-to-api/src'
import { buildHandoff } from '../packages/site-to-api/src/build'
import { runCapture } from '../packages/site-to-api/src/capture'
import { pipelineCommands } from '../packages/site-to-api/src/cli/commands'
import { run as runCli } from '../packages/site-to-api/src/cli/program'
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

  it('reports the script-set store cookie as set by the page, with a value a wrapper can derive', () => {
    const session = analysis.flows.session.find(entry => entry.host === host)
    expect(session?.cookies.find(cookie => cookie.name === 'pm_store')?.source).toBe('script')
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

describe('real-time channels', () => {
  function ticker(): NonNullable<Analysis['channels']>[number] {
    const found = analysis.channels?.find(channel => channel.host === host && channel.path === '/ws/ticker')
    if (!found)
      throw new Error(`no /ws/ticker channel; have: ${(analysis.channels ?? []).map(channel => channel.path).join(', ')}`)
    return found
  }

  it('finds the ticker with a subscribe message from the client and tick messages from the server', () => {
    const channel = ticker()
    const subscribe = channel.messages.find(message => message.direction === 'send' && message.discriminator?.value === 'subscribe')
    const tick = channel.messages.find(message => message.direction === 'receive' && message.discriminator?.value === 'tick')
    expect(subscribe?.schema?.required).toEqual(['type', 'productId'])
    expect(tick?.schema?.properties?.price).toEqual({ type: 'number' })
    expect(channel.handshake.map(step => step.message)).toEqual([subscribe?.id])
    expect(channel.connections).toBeGreaterThanOrEqual(2)
  })

  it('links the subscribed productId to the operation it came from', () => {
    const link = ticker().messages.find(message => message.discriminator?.value === 'subscribe')?.links.find(item => item.input === 'body./productId')
    const origin = link?.origin
    expect(origin?.kind).toMatch(/response|html/)
    const producer = origin && origin.kind !== 'user-input'
      ? analysis.operations.find(op => op.host === host && op.operationId === origin.operationId)
      : undefined
    expect(producer?.path).toMatch(/^\/(?:api\/)?products/)
  })

  it('documents the channel in AGENT.md, API_MAP.md, the AsyncAPI spec and the client README', () => {
    const guide = files.get('AGENT.md') ?? ''
    const section = guide.split('## Real-time channels')[1]?.split('\n## ')[0] ?? ''
    expect(section).toContain(`### \`ws://${host}/ws/ticker\``)
    expect(section).toMatch(/1\. `subscribe`, e\.g\. `\{"type":"subscribe","productId":\d+\}`/)
    expect(section).toContain('`tick`')
    expect(files.get('API_MAP.md')).toContain('## Real-time channels')
    const specName = `specs/${host.replace(/[^\w.-]/g, '_')}.asyncapi.yaml`
    expect(files.get(specName)).toMatch(/^asyncapi: 3\.0\.0\n/)
    expect(files.get(specName)).toContain('address: /ws/ticker')
    expect(files.get('client/README.md')).toContain(`\`ws://${host}/ws/ticker\``)
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

  it('lets callers use an SDK function without passing the captured constant headers', async () => {
    const usage = join(outDir, 'usage-check.ts')
    await writeFile(usage, [
      `import { createSiteClient } from './client'`,
      `const { sdk } = createSiteClient({ host: ${JSON.stringify(host)} })`,
      `export const pending = sdk.${operation('GET', '/api/categories').operationId}({})`,
      '',
    ].join('\n'))
    try {
      const program = ts.createProgram([usage], {
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
    }
    finally {
      await rm(usage, { force: true })
    }
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

describe('gen', () => {
  it('regenerates the client from a committed handoff folder, with no raw captures present', async () => {
    const clone = join(work, 'fresh-clone')
    await rm(clone, { recursive: true, force: true })
    await cp(outDir, join(clone, 'api-handoff'), { recursive: true })
    await rm(join(clone, 'api-handoff', 'client'), { recursive: true, force: true })
    await runCli([
      'node',
      'site-to-api',
      '--cwd',
      clone,
      'gen',
    ], pipelineCommands)
    expect(existsSync(join(clone, 'api-handoff', 'client', 'index.ts'))).toBe(true)
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

describe('first-time use through the CLI: build options stick and the docs agree', () => {
  const cliOut = (): string => join(work, 'cli-handoff')
  const cli = async (...args: string[]): Promise<void> => {
    await runCli([
      'node',
      'site-to-api',
      '--cwd',
      work,
      '--raw-dir',
      join(work, 'raw'),
      '--out-dir',
      cliOut(),
      ...args,
    ], pipelineCommands)
    expect(process.exitCode ?? 0).toBe(0)
  }
  const read = async (name: string): Promise<string> => readFile(join(cliOut(), name), 'utf8')
  const row = (map: string, id: string): string => map.split('\n').find(line => line.startsWith(`| \`${id}\``)) ?? ''

  it('probe and gen keep the redaction and client choices of the last build', async () => {
    await rm(cliOut(), { recursive: true, force: true })
    await cli('build', '--examples', 'none', '--no-client')
    expect(JSON.parse(await read('build.json'))).toMatchObject({
      examples: 'none',
      client: false,
      sticky: ['gen.client', 'redact.examples'],
    })
    expect(await read('AGENT.md')).toContain('No example values were written')
    expect(await read('AGENT.md')).toContain('- No client generated: run `site-to-api gen`.')
    expect(await read('API_MAP.md')).toContain('no client has been generated yet')

    await cli('probe', '--max-rps', '10')
    const guide = await read('AGENT.md')
    expect(guide).toContain('No example values were written')
    for (const [name, content] of await readAll(join(cliOut(), 'specs')))
      expect(content, name).not.toMatch(/^\s*examples:/m)
    expect(existsSync(join(cliOut(), 'client'))).toBe(false)
    expect(guide).toContain('- No client generated: run `site-to-api gen`.')

    // Probe results replace what the capture showed, and say so.
    const map = await read('API_MAP.md')
    const categories = operation('GET', '/api/categories').operationId
    expect(row(map, categories)).toContain('cookies: `_abck`; browser session (confirmed by probe)')
    expect(guide).toMatch(/Cookie `_abck`: [^\n]*Needed by \d+ requests \(confirmed by probe\)/)
    expect(guide).toMatch(/Cookie `bm_sz`: [^\n]*Seen in capture, but none of the \d+ requests probe tested needed it/)
    expect(guide).toMatch(/`probe` did not work out which cookies and headers \d+ operations on `[^`]+` need .*`site-to-api probe --minimize-per-host \d+`/)

    // Bot-protection steps list no needs; references are qualified and path inputs named.
    expect(row(map, 'postShieldCollect').split(' | ')[6]).toBe('')
    expect(map).not.toMatch(/← `s\d+`/)
    expect(map).not.toMatch(/`path\.\d+`/)
    expect(map).toMatch(/`path\.productId` ← `[a-z0-9-]+\.s\d+` \(`getApiProducts`\)/)
    expect(map).toMatch(/`header\.authorization` ← `sign-in-2\.s\d+` \(`postApiAuthLogin`\) → `body\.\/token` \(substring\)/)

    await cli('gen')
    expect(existsSync(join(cliOut(), 'client', 'index.ts'))).toBe(true)
    const generated = await read('AGENT.md')
    expect(generated).toContain('5. `client/`: typed client with Zod validation')
    expect(generated).not.toContain('No client generated')
    // gen rewrites only the client sentences: the channels section and table survive.
    expect(generated).toContain('## Real-time channels')
    expect(await read('API_MAP.md')).toContain('## Real-time channels')
    expect(await read('API_MAP.md')).toContain('exported by the generated `client/`')
    expect(JSON.parse(await read('build.json'))).toMatchObject({
      client: true,
      sticky: ['redact.examples'],
    })

    // A higher limit minimizes everything; examples stay off and the client generated by gen stays current.
    await cli('probe', '--max-rps', '10', '--minimize-per-host', '50')
    const reprobed = await read('AGENT.md')
    expect(JSON.parse(await read('probe.json'))).toMatchObject({ minimizePerHost: 50 })
    expect(reprobed).not.toContain('did not work out')
    expect(reprobed).toContain('No example values were written')
    expect(reprobed).toContain('5. `client/`: typed client with Zod validation')
    expect(row(await read('API_MAP.md'), operation('GET', '/api/products').operationId)).toContain('(confirmed by probe)')

    await cli('build', '--no-client')
    expect(await read('AGENT.md')).toContain('- `client/` is from an earlier build and was not regenerated (`--no-client`)')
    expect(await read('API_MAP.md')).toContain('`client/` is from an earlier build and may not match it')
  }, 240_000)

  it('warns about an include pattern that matches no host and adds no code-only endpoints for other hosts', async () => {
    const result = await buildHandoff({
      config: {
        ...config,
        outDir: join(work, 'include-typo'),
        hosts: {
          include: ['localhost:9999'],
          exclude: [],
        },
      },
      cwd: work,
    })
    expect(result.warnings.some(warning => warning.startsWith('hosts.include pattern "localhost:9999" matches no captured host'))).toBe(true)
    expect(result.analysis.operations.filter(op => op.sourceOnly)).toEqual([])
  }, 120_000)
})
