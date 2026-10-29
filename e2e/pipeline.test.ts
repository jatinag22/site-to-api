/**
 * The whole pipeline against the Pinewood Market fixture: capture three scripted sessions in a
 * real (headless) Chromium, build the handoff folder, probe the live site, then type-check and
 * use the generated client. Every assertion is about output a coding agent would rely on.
 */
import type { Analysis, ResolvedConfig } from '../packages/site-to-api/src'
import type { FixtureSite } from './fixture-site/server'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { join, relative } from 'pathe'
import { chromium } from 'playwright'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConfigSchema } from '../packages/site-to-api/src'
import { buildHandoff } from '../packages/site-to-api/src/build'
import { runCapture } from '../packages/site-to-api/src/capture'
import { pipelineCommands } from '../packages/site-to-api/src/cli/commands'
import { run as runCli } from '../packages/site-to-api/src/cli/program'
import { probeOperations, writeProbeReport } from '../packages/site-to-api/src/probe'
import { startFixtureSite } from './fixture-site/server'

const execFileAsync = promisify(execFile)
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

/** Strict type check of `files`, as a project with the given module resolution would run it. */
function typeCheck(files: string[], resolution: 'bundler' | 'nodenext'): string[] {
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: resolution === 'bundler'
      ? ts.ModuleKind.ESNext
      : ts.ModuleKind.NodeNext,
    moduleResolution: resolution === 'bundler'
      ? ts.ModuleResolutionKind.Bundler
      : ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
  })
  return ts.getPreEmitDiagnostics(program).map(d => `${d.file
    ? relative(outDir, d.file.fileName)
    : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
}

function clientSources(): string[] {
  return [
    ...files.keys(),
  ].filter(name => name.startsWith('client/') && name.endsWith('.ts')).map(name => join(outDir, name))
}

/**
 * A first-time user's login, written against the generated client only: the CSRF token read from
 * the login page, the password encrypted the way the page does it, the bearer token from the
 * login response, and the browser's bot-protection cookies, sent together.
 */
function loginDriver(): string {
  return [
    `import type { BrowserCookie } from './client/index.js'`,
    `import { browserSession, combineSessions, CookieJar, createSiteClient, extractCsrfTokenFromGetLogin, tokenSession } from './client/index.js'`,
    `import { encryptPassword } from '${relative(outDir, join(here, 'fixture-site', 'app', 'src', 'auth', 'crypto.js'))}'`,
    ``,
    `const host = ${JSON.stringify(host)}`,
    ``,
    `export async function run(origin: string, bootstrap: () => Promise<BrowserCookie[]>) {`,
    `  const jar = new CookieJar()`,
    `  const browser = browserSession({ jar, bootstrap })`,
    `  let token: string | undefined`,
    `  const { sdk } = createSiteClient({ host, jar, session: browser, baseUrl: origin, auth: () => token && \`Bearer \${token}\` })`,
    `  const before = await sdk.getApiOrders({})`,
    `  const page = await sdk.getLogin({})`,
    `  const csrf = typeof page.data === 'string' ? extractCsrfTokenFromGetLogin(page.data) : null`,
    `  if (csrf === null)`,
    `    throw new Error('no CSRF token on the login page')`,
    `  const key = await sdk.getApiAuthKey({})`,
    `  // One capture of each: response fields are not promised (decision 0034), so check them.`,
    `  const publicKey = key.data?.publicKey`,
    `  if (publicKey === undefined)`,
    `    throw new Error(\`no login key: \${String(key.error)}\`)`,
    `  const login = await sdk.postApiAuthLogin({`,
    `    body: { username: 'demo', password: await encryptPassword('demo-password', publicKey) },`,
    `    headers: { 'x-csrf-token': csrf },`,
    `  })`,
    `  if (login.data === undefined)`,
    `    throw new Error(\`login failed: \${String(login.error)}\`)`,
    `  token = login.data.token`,
    `  const orders = await sdk.getApiOrders({})`,
    `  // The same credentials as one session: the token goes on every request instead.`,
    `  const combined = createSiteClient({`,
    `    host,`,
    `    jar,`,
    `    baseUrl: origin,`,
    `    session: combineSessions(browser, tokenSession({ getToken: () => token ?? '' })),`,
    `  })`,
    `  const again = await combined.sdk.getApiOrders({})`,
    `  return {`,
    `    beforeStatus: before.response?.status ?? 0,`,
    `    loginStatus: login.response?.status ?? 0,`,
    `    ordersStatus: orders.response?.status ?? 0,`,
    `    orders: orders.data?.orders?.length ?? 0,`,
    `    combinedStatus: again.response?.status ?? 0,`,
    `    combinedOrders: again.data?.orders?.length ?? 0,`,
    `    cookies: jar.all().map(cookie => cookie.name).sort(),`,
    `  }`,
    `}`,
    ``,
  ].join('\n')
}

const LoginResultSchema = z.object({
  beforeStatus: z.number(),
  loginStatus: z.number(),
  ordersStatus: z.number(),
  orders: z.number(),
  combinedStatus: z.number(),
  combinedOrders: z.number(),
  cookies: z.array(z.string()),
})

/** What `bootstrap` of a browser session returns: the cookies a real browser received. */
async function browserCookies() {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(site.origin, { waitUntil: 'networkidle' })
    return await page.context().cookies()
  }
  finally {
    await browser.close()
  }
}

/** The per-cookie lines of AGENT.md or client/README.md, which must say the same thing. */
function cookieLines(markdown: string): string[] {
  return markdown.split('\n').filter(line => line.startsWith('- Cookie `')).sort()
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

  it('gives the same cookie facts in the client README as in AGENT.md before probe', () => {
    const guide = cookieLines(files.get('AGENT.md') ?? '')
    expect(guide.length).toBeGreaterThan(0)
    expect(cookieLines(files.get('client/README.md') ?? '')).toEqual(guide)
    expect(files.get('client/README.md')).not.toContain('Cookies the API needs')
  })

  it('does not read a page number from the viewport meta tag by coincidence', () => {
    const inputs = analysis.flows.flows.flatMap(flow => flow.steps.flatMap(step => Object.entries(step.inputs)))
    expect(inputs.filter(([name, origin]) => name === 'query.page' && origin.kind === 'html' && origin.selector.includes('viewport'))).toEqual([])
    expect(files.get('client/README.md')).not.toContain('meta[name="viewport"]')
    expect(files.get('client/README.md')).not.toContain('initial-scale')
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

describe('fitted to the site, not to the captured samples', () => {
  it('infers no enum of product names and keeps code-like enums', () => {
    const orders = operation('GET', '/api/orders').responses.find(response => response.status === 200)?.schema
    const item = orders?.properties?.orders?.items?.properties?.items?.items
    expect(item?.properties?.name).toBeDefined()
    expect(item?.properties?.name?.enum).toBeUndefined()
    expect(operation('GET', '/api/products').query.find(param => param.name === 'category')?.schema.enum).toEqual(['beverages', 'snacks'])
  })

  it('keeps per-session and browser-identity headers out of constant defaults', () => {
    const csrf = operation('POST', '/api/auth/login').headers.find(header => header.name === 'x-csrf-token')
    expect(csrf?.constant).toBe(false)
    expect(csrf?.schema.default).toBeUndefined()
    for (const op of analysis.operations.filter(entry => entry.host === host)) {
      const agent = op.headers.find(header => header.name === 'user-agent')
      expect(agent?.constant ?? false).toBe(false)
      expect(agent?.schema.default).toBeUndefined()
    }
  })

  it('names any item of a list as the producer, never the index or position one sample used', () => {
    const inputs = analysis.flows.flows.flatMap(flow => flow.steps.flatMap(step => Object.values(step.inputs)))
    const outputs = inputs.flatMap(origin => origin.kind === 'step'
      ? [origin.output]
      : [])
    expect(outputs).toContain('body./*/slug')
    expect(outputs.filter(output => /\/\d+\//.test(output))).toEqual([])
    const stores = inputs.filter(origin => origin.kind === 'html' && origin.selector.startsWith('#store-list'))
    expect(stores.length).toBeGreaterThan(0)
    for (const origin of stores)
      expect(origin).toMatchObject({ selector: '#store-list > li > a:nth-of-type(1)', repeated: true })
  })

  it('lists the typed password among the values the encryption uses', () => {
    const computed = analysis.flows.computedValues.find(value => value.input === 'body./password')
    expect(computed?.uses).toContainEqual({ kind: 'user-input', field: 'password' })
  })

  it('masks account fields and keeps the auth scheme in examples', () => {
    const spec = [...files].find(([name]) => name.startsWith('specs/') && !name.endsWith('.asyncapi.yaml'))?.[1] ?? ''
    expect(spec).toContain('tokenType: Bearer')
    expect(spec).toContain('displayName: Xxxx Xxxxxxx')
    for (const [name, content] of files) {
      for (const personal of ['Demo Shopper', 'usr_demo_0001'])
        expect(content.includes(personal), `${name} contains ${personal}`).toBe(false)
    }
  })

  it('points flows.json only at Markdown excerpts that were written', () => {
    const flows = files.get('flows.json') ?? ''
    const referenced = [
      ...new Set(flows.match(/source\/[^"]+/g) ?? []),
    ]
    expect(referenced.length).toBeGreaterThan(0)
    for (const path of referenced) {
      expect(path, path).toMatch(/\.L\d+(?:-\d+|C\d+)\.[a-z]+\.md$/)
      expect(files.has(path), `${path} was written`).toBe(true)
    }
    const written = [
      ...files.keys(),
    ].filter(name => name.startsWith('source/'))
    expect(written.every(name => name.endsWith('.md'))).toBe(true)
  })

  it('writes no excerpt of the bot-protection sensor script, only of the site\'s own code', () => {
    const excerpts = [
      ...files.keys(),
    ].filter(name => name.startsWith('source/'))
    expect(excerpts.length).toBeGreaterThan(0)
    expect(excerpts.filter(name => name.includes('shield/sensor'))).toEqual([])
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
  it('type-checks in strict mode under moduleResolution bundler and nodenext', () => {
    expect(typeCheck(clientSources(), 'bundler')).toEqual([])
    // nodenext rejects extensionless relative imports (TS2835); the client uses `.js` throughout.
    expect(typeCheck(clientSources(), 'nodenext')).toEqual([])
  })

  it('runs under plain node once compiled with nodenext settings', async () => {
    const compiled = join(work, 'compiled-client')
    await rm(compiled, { recursive: true, force: true })
    const program = ts.createProgram(clientSources(), {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      types: [],
      rootDir: outDir,
      outDir: compiled,
    })
    const emitted = program.emit()
    expect(emitted.diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
    // Plain node, no loader: the compiled client resolves its own files, the runtime and zod.
    const script = [
      `const client = await import(${JSON.stringify(pathToFileURL(join(compiled, 'client', 'index.js')).href)})`,
      `const { sdk } = client.createSiteClient({ host: ${JSON.stringify(host)}, baseUrl: ${JSON.stringify(site.origin)} })`,
      `const page = await sdk.getLogin({})`,
      `console.log(JSON.stringify({ status: page.response.status, csrf: client.extractCsrfTokenFromGetLogin(page.data) !== null }))`,
    ].join('\n')
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: work })
    expect(JSON.parse(stdout)).toEqual({ status: 200, csrf: true })
  }, 60_000)

  it('logs in through the generated SDK and reads the orders with browser cookies and a bearer token', async () => {
    const driver = join(outDir, 'login-check.ts')
    await writeFile(driver, loginDriver())
    try {
      // The way a user writes it must type-check, under both module resolutions.
      expect(typeCheck([driver], 'bundler')).toEqual([])
      expect(typeCheck([driver], 'nodenext')).toEqual([])
      const loaded: unknown = await import(pathToFileURL(driver).href)
      if (typeof loaded !== 'object' || loaded === null || !('run' in loaded) || typeof loaded.run !== 'function')
        throw new Error('login-check.ts did not export run()')
      const result = LoginResultSchema.parse(await loaded.run(site.origin, browserCookies))
      expect(result.beforeStatus).toBe(401)
      expect(result.loginStatus).toBe(200)
      expect(result.ordersStatus).toBe(200)
      expect(result.orders).toBeGreaterThan(0)
      expect(result.combinedStatus).toBe(200)
      expect(result.combinedOrders).toBe(result.orders)
      expect(result.cookies).toEqual(expect.arrayContaining(['_abck', 'bm_sz', 'pm_session']))
    }
    finally {
      await rm(driver, { force: true })
    }
  }, 120_000)

  it('lets callers use an SDK function without passing the captured constant headers', async () => {
    const usage = join(outDir, 'usage-check.ts')
    await writeFile(usage, [
      `import { createSiteClient } from './client'`,
      `const { sdk } = createSiteClient({ host: ${JSON.stringify(host)} })`,
      `export const pending = sdk.${operation('GET', '/api/categories').operationId}({})`,
      '',
    ].join('\n'))
    try {
      expect(typeCheck([usage], 'bundler')).toEqual([])
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

describe('graphQL (decision 0027)', () => {
  function graphqlOperation(name: string): Analysis['operations'][number] {
    const found = analysis.operations.find(op => op.host === host && op.graphql?.operationName === name)
    if (!found) {
      throw new Error(`no GraphQL operation ${name}; have: ${analysis.operations.flatMap(op => op.graphql
        ? [op.graphql.operationName]
        : []).join(', ')}`)
    }
    return found
  }

  it('splits /api/graphql into one operation per GraphQL operation, with its type', () => {
    const graphql = analysis.operations.filter(op => op.host === host && op.graphql?.endpoint === '/api/graphql')
    expect(graphql.map(op => [
      op.operationId,
      op.method,
      op.path,
      op.graphql?.operationType,
      op.graphql?.operationTypeFrom,
    ]).sort()).toEqual([
      [
        'addToWishlist',
        'POST',
        '/api/graphql#AddToWishlist',
        'mutation',
        'document',
      ],
      [
        'productStock',
        'POST',
        '/api/graphql#ProductStock',
        'query',
        'document',
      ],
      [
        'storeHours',
        'GET',
        '/api/graphql#StoreHours',
        'query',
        'get',
      ],
    ])
    // The REST templating never sees GraphQL requests: no `/api/{param}` catch-all appears.
    expect(analysis.operations.some(op => op.host === host && op.path.startsWith('/api/{'))).toBe(false)
    expect(graphqlOperation('StoreHours').graphql?.persistedQuery?.sha256Hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('types each operation\'s own variables, also when GET sends them as JSON text', () => {
    const stock = graphqlOperation('ProductStock').requestBody?.schema
    expect(stock?.properties?.variables).toMatchObject({
      properties: {
        productId: { type: 'integer' },
      },
      required: ['productId'],
    })
    expect(stock?.properties?.query?.const).toContain('query ProductStock(')
    const variables = graphqlOperation('StoreHours').query.find(param => param.name === 'variables')
    expect(variables).toMatchObject({
      json: true,
      schema: {
        properties: {
          slug: { type: 'string' },
        },
      },
    })
  })

  it('traces values into variables like body fields', () => {
    const steps = analysis.flows.flows.flatMap(flow => flow.steps)
    const stock = steps.filter(step => step.operationId === 'productStock')
    expect(stock.length).toBeGreaterThan(0)
    expect(stock.some(step => step.inputs['body./variables/productId']?.kind === 'step')).toBe(true)
  })

  it('lists the operations per endpoint in AGENT.md and API_MAP.md', () => {
    const guide = files.get('AGENT.md') ?? ''
    const section = guide.split('## GraphQL operations')[1]?.split('\n## ')[0] ?? ''
    expect(section).toContain(`### \`POST ${host}/api/graphql\``)
    expect(section).toMatch(/- `AddToWishlist`: mutation \(from the query document\), sends the query document, variables `productId: integer`\. Client: `sdk\.addToWishlist\(\{ variables \}\)`/)
    expect(section).toMatch(/- `StoreHours`: query \(sent with GET, which GraphQL allows for queries only\), persisted query `[0-9a-f]{64}`, variables `slug: string`/)
    const map = files.get('API_MAP.md') ?? ''
    expect(map).toContain(`### GET ${host}/api/graphql`)
    expect(map).toContain('| `productStock` | `POST /api/graphql#ProductStock` | api (GraphQL query) |')
  })

  it('calls the operations through the generated client with only their variables', async () => {
    const driver = join(outDir, 'graphql-check.ts')
    await writeFile(driver, [
      `import type { BrowserCookie } from './client/index.js'`,
      `import { browserSession, CookieJar, createSiteClient } from './client/index.js'`,
      ``,
      `export async function run(origin: string, bootstrap: () => Promise<BrowserCookie[]>) {`,
      `  const jar = new CookieJar()`,
      `  const session = browserSession({ jar, bootstrap })`,
      `  await session.refresh()`,
      `  const { sdk } = createSiteClient({ host: ${JSON.stringify(host)}, jar, session, baseUrl: origin })`,
      `  const stock = await sdk.productStock({ variables: { productId: 1007 } })`,
      `  const hours = await sdk.storeHours({ variables: { slug: 'cedar-park' } })`,
      `  const saved = await sdk.addToWishlist({ variables: { productId: 1008 } })`,
      `  return {`,
      `    stock: stock.data?.data.productStock.stores ?? null,`,
      `    hours: hours.data?.data.storeHours.slug ?? null,`,
      `    saved: saved.data?.data.addToWishlist.productIds.includes(1008) ?? false,`,
      `    errors: [stock.error, hours.error, saved.error].filter(error => error !== undefined).map(String),`,
      `  }`,
      `}`,
      ``,
    ].join('\n'))
    try {
      expect(typeCheck([driver], 'bundler')).toEqual([])
      expect(typeCheck([driver], 'nodenext')).toEqual([])
      const loaded: unknown = await import(pathToFileURL(driver).href)
      if (typeof loaded !== 'object' || loaded === null || !('run' in loaded) || typeof loaded.run !== 'function')
        throw new Error('graphql-check.ts did not export run()')
      expect(await loaded.run(site.origin, browserCookies)).toEqual({
        stock: expect.any(Number),
        hours: 'cedar-park',
        saved: true,
        errors: [],
      })
    }
    finally {
      await rm(driver, { force: true })
    }
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
    // GraphQL queries are replayed like GETs, even over POST; the mutation is left alone.
    expect(report.operations.find(result => result.operationId === 'productStock')).toMatchObject({ method: 'POST', replay: 'ok' })
    expect(report.operations.find(result => result.operationId === 'storeHours')).toMatchObject({ method: 'GET', replay: 'ok' })
    expect(report.skipped).toContainEqual({ operationId: 'addToWishlist', reason: 'GraphQL mutation AddToWishlist can change data; pass --unsafe-methods to include it' })
    await writeProbeReport(outDir, report)
    const rebuilt = await buildHandoff({ config, cwd: work })
    expect(rebuilt.analysis.flows.session.find(entry => entry.host === host)?.probed).toBe(true)

    // The client README repeats AGENT.md's probe results, including cookies no request needed.
    const guide = await readFile(join(outDir, 'AGENT.md'), 'utf8')
    const readme = await readFile(join(outDir, 'client', 'README.md'), 'utf8')
    expect(cookieLines(readme)).toEqual(cookieLines(guide))
    expect(readme).toMatch(/Cookie `bm_sz`: [^\n]*Seen in capture, but none of the \d+ requests probe tested needed it/)
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
    expect(map).toMatch(/`path\.productId` ← `[a-z0-9-]+\.s\d+` \(`getApiProducts`\) → `body\.\/items\/\*\/id` \(one of the items\)/)
    expect(map).toMatch(/`cookie\.pm_store` ← `stores\.s\d+` \(`getStores`\) → html one of the elements matching `[^`]+`/)
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
