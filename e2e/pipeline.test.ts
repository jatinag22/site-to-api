import type { CallToolResult } from '@modelcontextprotocol/server'
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
import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
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
import { generateClient } from '../packages/site-to-api/src/gen'
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

/** `AGENT.md` and every `hosts/<host>.md` of a handoff folder: the docs an agent reads. */
function docs(folder: Map<string, string>): string {
  return [...folder].filter(([name]) => name === 'AGENT.md' || name.startsWith('hosts/')).map(([, content]) => content).join('\n')
}

/** The detail file of one host (`hosts/<host>.md`, decision 0041). */
function hostDoc(folder: Map<string, string>, name: string): string {
  return folder.get(`hosts/${name.replace(/[^\w.-]/g, '_')}.md`) ?? ''
}

/** The per-cookie lines of the host files or client/README.md, which must say the same thing. */
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

  it('keeps AGENT.md a short index that links one file per host (decision 0041)', () => {
    const guide = files.get('AGENT.md') ?? ''
    expect(guide.length).toBeLessThan(25_000)
    const stem = host.replace(/[^\w.-]/g, '_')
    expect(guide).toContain(`[\`hosts/${stem}.md\`](hosts/${stem}.md)`)
    expect(guide.indexOf('## Hosts')).toBeLessThan(guide.indexOf('## Key flows'))
    expect(guide.indexOf('## Key flows')).toBeLessThan(guide.indexOf('## Gaps'))
    // The login comes first among the flows, whatever order they were captured in.
    const firstFlow = guide.split('## Key flows')[1]?.split('\n').find(line => line.startsWith('- [')) ?? ''
    expect(firstFlow).toContain('`postApiAuthLogin`')
    const detail = hostDoc(files, host)
    expect(detail.startsWith(`# ${host}\n`)).toBe(true)
    for (const section of [
      '## Session',
      '## Operations',
      '## Flows',
      '## Real-time channels',
      '## Gaps',
    ])
      expect(detail, section).toContain(`\n${section}\n`)
    // Every operation of the host is named in its file.
    for (const entry of analysis.operations.filter(op => op.host === host))
      expect(detail, entry.operationId).toContain(`- \`${entry.operationId}\`: `)
  })

  it('has every section the demo script prints', async () => {
    // scripts/demo/demo.tape runs against the shop on localhost:4173; here the port is random.
    const tape = await readFile(join(here, '..', 'scripts', 'demo', 'demo.tape'), 'utf8')
    const ranges = [
      ...tape.matchAll(/sed -n '\/([^/]+)\/,\/[^/]+\/p' api-handoff\/([^\s"]+)/g),
    ]
    expect(ranges.length).toBeGreaterThan(0)
    for (const [, start, file] of ranges) {
      const name = (file ?? '').replace('localhost_4173', host.replace(/[^\w.-]/g, '_'))
      expect(files.get(name), `${file} for ${start}`).toMatch(new RegExp(`^${start}`, 'm'))
    }
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
    const guide = docs(files)
    expect(guide).not.toMatch(/`body\.\/sensor_data` of/)
    expect(guide).not.toMatch(/`path\.\d+` of `getApiStockTxt`/)
  })

  it('gives the same cookie facts in the client README as in the host files before probe', () => {
    const guide = cookieLines(docs(files))
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

  it('describes the sessions keyed by session id as a map and never writes the ids (decision 0042)', () => {
    const me = analysis.operations.find(op => op.method === 'GET' && op.path === '/api/me')
    expect(me?.responses[0]?.schema?.properties?.sessions).toMatchObject({
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          current: { type: 'boolean' },
        },
      },
    })
    expect(me?.responses[0]?.schema?.properties?.sessions?.properties).toBeUndefined()
    const ids = (me?.exchanges ?? []).flatMap(exchange => exchange.request.cookies
      .filter(cookie => cookie.name === 'pm_session')
      .map(cookie => cookie.value))
    expect(ids.length).toBeGreaterThan(0)
    for (const [name, content] of files) {
      for (const id of new Set(ids))
        expect(content.includes(id), `${name} contains a session id`).toBe(false)
    }
    const spec = [...files].find(([name]) => name.startsWith('specs/') && !name.endsWith('.asyncapi.yaml'))?.[1] ?? ''
    expect(spec).toContain('<redacted: 32 hex chars>')
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

  it('documents the channel in AGENT.md, its host file, API_MAP.md, the AsyncAPI spec and the client README', () => {
    expect(files.get('AGENT.md')).toContain(`- \`ws://${host}/ws/ticker\`: JSON / text; send \`subscribe\` after connecting; details in [\`hosts/`)
    const guide = hostDoc(files, host)
    const section = guide.split('## Real-time channels')[1]?.split('\n## ')[0] ?? ''
    expect(section).toContain(`### \`ws://${host}/ws/ticker\``)
    expect(section).toMatch(/1\. `subscribe` \(subscription\), e\.g\. `\{"type":"subscribe","productId":\d+\}`/)
    expect(section).toContain('`tick`')
    expect(files.get('API_MAP.md')).toContain('## Real-time channels')
    const specName = `specs/${host.replace(/[^\w.-]/g, '_')}.asyncapi.yaml`
    expect(files.get(specName)).toMatch(/^asyncapi: 3\.0\.0\n/)
    expect(files.get(specName)).toContain('address: /ws/ticker')
    expect(files.get('client/README.md')).toContain(`\`ws://${host}/ws/ticker\``)
  })
})

describe('framed WebSocket protocols (decision 0038)', () => {
  function channelAt(path: string): NonNullable<Analysis['channels']>[number] {
    const found = analysis.channels?.find(channel => channel.host === host && channel.path === path)
    if (!found)
      throw new Error(`no ${path} channel; have: ${(analysis.channels ?? []).map(channel => channel.path).join(', ')}`)
    return found
  }
  const named = (channel: NonNullable<Analysis['channels']>[number], direction: 'send' | 'receive', name: string): NonNullable<Analysis['channels']>[number]['messages'][number] | undefined =>
    channel.messages.find(message => message.direction === direction && message.protocol?.name === name)

  it('names Socket.IO messages by event and gives each payload a schema', () => {
    const channel = channelAt('/socket.io/')
    expect(channel.protocol).toMatchObject({ id: 'socket.io', version: 'Engine.IO 4' })
    expect(channel.protocol?.evidence).toContain('URL path ends in /socket.io/')
    const stock = named(channel, 'receive', 'stock')
    expect(stock?.protocol).toMatchObject({ frame: 'event', wire: '42["stock",<payload>]' })
    expect(stock?.schema?.properties).toMatchObject({
      productId: { type: 'integer' },
      inStock: { type: 'integer' },
      seq: { type: 'integer' },
    })
    expect(named(channel, 'send', 'watch')?.protocol?.frame).toBe('event')
    expect(named(channel, 'receive', 'watch')?.protocol?.frame).toBe('ack')
    expect(named(channel, 'receive', 'ping')?.protocol?.role).toBe('keepalive')
    expect(channel.messages.every(message => message.discriminator === null)).toBe(true)
    // The long-polling requests are the channel's transport, not HTTP operations.
    expect(analysis.operations.some(op => op.path.startsWith('/socket.io'))).toBe(false)
  })

  it('summarises how the Socket.IO connection is opened and authenticated', () => {
    const channel = channelAt('/socket.io/')
    expect(channel.handshake.map(step => [step.message, step.role])).toEqual([
      ['sendConnect', 'auth'],
      ['sendUpgrade', 'init'],
      ['sendWatch', 'subscribe'],
    ])
    expect(channel.connection).toMatchObject({
      origins: [site.origin],
      subprotocols: { requested: [], selected: [] },
      firstMessage: { message: 'sendConnect', role: 'auth', reply: 'receiveConnect' },
      transports: ['polling', 'websocket'],
    })
    expect(channel.connection.upgrade).toMatchObject({
      rejected: 0,
      unknown: 0,
      statuses: [101],
    })
    expect(channel.connection.upgrade.accepted).toBeGreaterThanOrEqual(2)
    expect(channel.connection.urlTokens).toEqual(['sid'])
    const guide = hostDoc(files, host)
    expect(guide).toContain('- Protocol: Socket.IO (Engine.IO 4), shown by URL path ends in /socket.io/, frames.')
    expect(guide).toContain('- First authentication message: `connect`; the server\'s next message was `connect`.')
    expect(guide).toMatch(/1\. `connect` \(authentication\), sent as `40<payload>`, e\.g\. `\{"token":"[^"]*redacted[^"]*"\}`/)
    const spec = files.get(`specs/${host.replace(/[^\w.-]/g, '_')}.asyncapi.yaml`) ?? ''
    expect(spec).toContain('x-site-to-api-protocol:')
    expect(spec).toContain('x-site-to-api-connection:')
    expect(spec).toContain('name: stock')
  })

  it('never writes the live token sent in the Socket.IO connect payload', async () => {
    const raw = await readFile(join(work, 'raw', 'browse', 'traffic.har'), 'utf8')
    const tokens = [
      ...new Set(raw.match(/lt_[0-9a-f]{32}/g) ?? []),
    ]
    expect(tokens.length).toBeGreaterThan(0)
    expect(raw).toMatch(/40\{\\"token\\":\\"lt_[0-9a-f]{32}\\"\}/)
    for (const [name, content] of files) {
      for (const token of tokens)
        expect(content.includes(token), `${name} contains the live token`).toBe(false)
    }
  })

  it('decodes the MessagePack basket and groups it by its type field', () => {
    const channel = channelAt('/ws/basket')
    expect(channel.protocol).toBeNull()
    const hello = channel.messages.find(message => message.id === 'sendHello')
    const basket = channel.messages.find(message => message.id === 'receiveBasket')
    expect(hello).toMatchObject({
      format: 'msgpack',
      discriminator: { field: 'type', value: 'hello' },
    })
    expect(basket).toMatchObject({
      format: 'msgpack',
      discriminator: { field: 'type', value: 'basket' },
    })
    expect(basket?.schema?.properties).toMatchObject({
      items: { type: 'integer' },
      totalInr: { type: 'number' },
    })
    expect(hello?.links.find(link => link.input === 'body./productId')?.origin.kind).toMatch(/response|html/)
    const spec = files.get(`specs/${host.replace(/[^\w.-]/g, '_')}.asyncapi.yaml`) ?? ''
    expect(spec).toContain('contentType: application/msgpack')
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

  it('lists the operations per endpoint in AGENT.md, the host file and API_MAP.md', () => {
    expect(files.get('AGENT.md')).toMatch(new RegExp(`^- \`POST ${host.replace(/\./g, '\\.')}/api/graphql\`: \\d+ operations \\(`, 'm'))
    const guide = hostDoc(files, host)
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

describe('dispatcher endpoints (decision 0039)', () => {
  it('splits /api/store-api into one operation per functionName', () => {
    const functions = analysis.operations.filter(op => op.host === host && op.dispatch?.endpoint === '/api/store-api')
    expect(functions.map(op => [
      op.operationId,
      op.method,
      op.path,
      op.dispatch?.parameter,
      op.dispatch?.in,
      op.query.map(param => param.name).sort(),
    ]).sort()).toEqual([
      [
        'getStoreInfo',
        'GET',
        '/api/store-api#getStoreInfo',
        'functionName',
        'query',
        ['functionName', 'slug'],
      ],
      [
        'getStoreServices',
        'GET',
        '/api/store-api#getStoreServices',
        'functionName',
        'query',
        ['functionName'],
      ],
    ])
    // The dispatcher value is a constant of each function, which the client sends.
    const info = functions.find(op => op.operationId === 'getStoreInfo')
    expect(info?.query.find(param => param.name === 'functionName')).toMatchObject({
      required: true,
      schema: { const: 'getStoreInfo', default: 'getStoreInfo' },
    })
    expect(analysis.operations.some(op => op.host === host && op.path === '/api/store-api')).toBe(false)
  })

  it('marks the functions in the spec and lists them in AGENT.md, the host file and API_MAP.md', () => {
    const spec = files.get(`specs/${host.replace(/[^\w.-]/g, '_')}.yaml`) ?? ''
    expect(spec).toContain('/api/store-api#getStoreInfo:')
    expect(spec).toMatch(/x-site-to-api-dispatch:\n\s+endpoint: \/api\/store-api\n\s+parameter: functionName\n\s+in: query\n\s+value: getStoreServices/)
    expect(files.get('AGENT.md')).toContain(`- \`GET ${host}/api/store-api\`: query parameter \`functionName\` picks one of`)
    const guide = hostDoc(files, host)
    const section = guide.split('## Dispatcher endpoints')[1]?.split('\n## ')[0] ?? ''
    expect(section).toContain(`### \`GET ${host}/api/store-api\``)
    expect(section).toContain('- `getStoreInfo`: parameters `slug`. Client: `sdk.getStoreInfo({ query: { slug } })`; spec path `/api/store-api#getStoreInfo`.')
    expect(section).toContain('- `getStoreServices`: no other parameters. Client: `sdk.getStoreServices()`')
    const map = files.get('API_MAP.md') ?? ''
    expect(map).toContain('| `getStoreServices` | `GET /api/store-api#getStoreServices` | api (function getStoreServices) |')
  })

  it('calls the functions through the generated client, which sends functionName itself', async () => {
    const driver = join(outDir, 'dispatch-check.ts')
    await writeFile(driver, [
      `import type { BrowserCookie } from './client/index.js'`,
      `import { browserSession, CookieJar, createSiteClient } from './client/index.js'`,
      ``,
      `export async function run(origin: string, bootstrap: () => Promise<BrowserCookie[]>) {`,
      `  const jar = new CookieJar()`,
      `  const session = browserSession({ jar, bootstrap })`,
      `  await session.refresh()`,
      `  const { sdk } = createSiteClient({ host: ${JSON.stringify(host)}, jar, session, baseUrl: origin })`,
      `  const info = await sdk.getStoreInfo({ query: { slug: 'cedar-park' } })`,
      `  const services = await sdk.getStoreServices()`,
      `  return {`,
      `    slug: info.data?.slug ?? null,`,
      `    url: info.response?.url ?? null,`,
      `    services: services.data?.services?.length ?? 0,`,
      `    errors: [info.error, services.error].filter(error => error !== undefined).map(String),`,
      `  }`,
      `}`,
      ``,
    ].join('\n'))
    try {
      expect(typeCheck([driver], 'bundler')).toEqual([])
      expect(typeCheck([driver], 'nodenext')).toEqual([])
      const loaded: unknown = await import(pathToFileURL(driver).href)
      if (typeof loaded !== 'object' || loaded === null || !('run' in loaded) || typeof loaded.run !== 'function')
        throw new Error('dispatch-check.ts did not export run()')
      expect(await loaded.run(site.origin, browserCookies)).toEqual({
        slug: 'cedar-park',
        url: `${site.origin}/api/store-api?slug=cedar-park&functionName=getStoreInfo`,
        services: 3,
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

/** The text of a tool result, failing the test when the tool reported an error. */
function toolText(result: Pick<CallToolResult, 'content' | 'isError'>): string {
  const first = result.content[0]
  const text = first?.type === 'text'
    ? first.text
    : ''
  if (result.isError === true)
    throw new Error(`tool error: ${text}`)
  return text
}

describe('mCP servers (decision 0043)', () => {
  const cli = join(here, '..', 'packages', 'site-to-api', 'bin', 'site-to-api.mjs')

  async function connect(command: string, args: string[], env: Record<string, string> = {}): Promise<Client> {
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(new StdioClientTransport({
      command,
      args,
      env: {
        ...getDefaultEnvironment(),
        ...env,
      },
      stderr: 'ignore',
    }))
    return client
  }

  it('serves the handoff folder to an agent and calls a read operation on the live site', async () => {
    const client = await connect(process.execPath, [
      cli,
      'mcp',
      outDir,
      '--allow-calls',
      '--max-rps',
      '10',
    ])
    try {
      const tools = (await client.listTools()).tools.map(tool => tool.name).sort()
      expect(tools).toEqual([
        'call_operation',
        'get_examples',
        'get_flow',
        'get_operation',
        'get_source',
        'list_hosts',
        'search_operations',
      ])
      const search = z.object({
        items: z.array(z.object({
          operationId: z.string(),
        })),
      })
        .parse(JSON.parse(toolText(await client.callTool({
          name: 'search_operations',
          arguments: { query: 'products' },
        }))))
      expect(search.items.map(item => item.operationId)).toContain('getApiProductsByProductId')
      const login = toolText(await client.callTool({
        name: 'get_operation',
        arguments: { operationId: 'postApiAuthLogin' },
      }))
      expect(login).toContain('"location": "header.x-csrf-token"')
      expect(login).toContain('meta[name=\\"csrf-token\\"]')
      expect(login).not.toContain('<redacted')
      const refused = await client.callTool({
        name: 'call_operation',
        arguments: {
          operationId: 'postApiAuthLogin',
          body: { username: 'demo', password: 'x' },
        },
      })
      expect(refused.isError).toBe(true)
      expect(toolText({ ...refused, isError: false })).toContain('--unsafe-methods')
      const page = toolText(await client.callTool({
        name: 'call_operation',
        arguments: {
          operationId: 'getProductsByProductId',
          path: { productId: '1007' },
        },
      }))
      expect(JSON.parse(page)).toMatchObject({ status: 200, ok: true })
    }
    finally {
      await client.close()
    }
  }, 120_000)

  it('generates a per-site server that calls the live site with cookies from the environment', async () => {
    const dir = join(work, 'mcp-handoff')
    await rm(dir, { recursive: true, force: true })
    await cp(outDir, dir, { recursive: true })
    await generateClient({ handoffDir: dir, flows: analysis.flows, mcp: 'read' })
    const cookies = (await browserCookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    const tsx = join(here, 'node_modules', '.bin', 'tsx')
    const client = await connect(tsx, [
      join(dir, 'client', 'mcp', 'server.ts'),
    ], { SITE_API_COOKIE: cookies, SITE_API_MAX_RPS: '10' })
    try {
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      expect(tools).toContain('getApiCategories')
      expect(tools).toContain('productStock')
      // Writes and browser-only steps get no tool in read mode.
      expect(tools).not.toContain('postApiAuthLogin')
      expect(tools).not.toContain('addToWishlist')
      expect(tools).not.toContain('postShieldCollect')
      const categories = toolText(await client.callTool({ name: 'getApiCategories', arguments: {} }))
      expect(categories.split('\n')[0]).toBe('HTTP 200')
      expect(categories).toContain('"slug"')
    }
    finally {
      await client.close()
    }
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
    // A GET dispatcher function is replayed like any GET, at the endpoint without the fragment.
    expect(report.operations.find(result => result.operationId === 'getStoreServices')).toMatchObject({ method: 'GET', replay: 'ok' })
    await writeProbeReport(outDir, report)
    const rebuilt = await buildHandoff({ config, cwd: work })
    expect(rebuilt.analysis.flows.session.find(entry => entry.host === host)?.probed).toBe(true)

    // The client README repeats the host files' probe results, including cookies no request needed.
    const guide = docs(await readAll(outDir))
    const readme = await readFile(join(outDir, 'client', 'README.md'), 'utf8')
    expect(cookieLines(readme)).toEqual(cookieLines(guide))
    expect(readme).toMatch(/Cookie `bm_sz`: [^\n]*Seen in capture, but none of the \d+ requests probe tested needed it/)
  }, 180_000)
})

describe('check', () => {
  const checkOut = (): string => join(work, 'check-handoff')
  /** Runs `site-to-api check` and returns its exit code and the stdout it printed. */
  const check = async (...args: string[]): Promise<{ code: number, stdout: string }> => {
    const written: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.exitCode = undefined
    try {
      await runCli([
        'node',
        'site-to-api',
        '--cwd',
        work,
        '--raw-dir',
        join(work, 'raw'),
        '--out-dir',
        checkOut(),
        'check',
        '--max-rps',
        '10',
        ...args,
      ], pipelineCommands)
      return {
        code: Number(process.exitCode ?? 0),
        stdout: written.join(''),
      }
    }
    finally {
      process.stdout.write = write
      process.exitCode = undefined
    }
  }
  const detail = (): string => operation('GET', '/api/products/{productId}').operationId

  it('finds no drift on an unchanged site, then reports an added and a removed field with exit code 1', async () => {
    await rm(checkOut(), { recursive: true, force: true })
    await runCli([
      'node',
      'site-to-api',
      '--cwd',
      work,
      '--raw-dir',
      join(work, 'raw'),
      '--out-dir',
      checkOut(),
      'build',
      '--no-client',
    ], pipelineCommands)
    process.exitCode = undefined

    site.setDrift(false)
    const same = await check('--operations', detail())
    expect(same.code).toBe(0)
    expect(same.stdout).toContain('Checked 1 operations: 1 ok, 0 drifted')

    site.setDrift(true)
    try {
      const drifted = await check('--operations', detail(), '--json')
      expect(drifted.code).toBe(1)
      const printed = JSON.parse(drifted.stdout)
      expect(printed).toMatchObject({ exitCode: 1 })
      const written = JSON.parse(await readFile(join(checkOut(), 'check.json'), 'utf8'))
      expect(written).toEqual(printed)
      expect(written.operations).toEqual([
        expect.objectContaining({
          operationId: detail(),
          verdict: 'drift',
          status: { expected: 200, actual: 200 },
          added: ['$.badge'],
          removed: ['$.mrpInr'],
          typeChanged: [],
        }),
      ])
      // Field paths only: no product name, price or other value from the live answer.
      expect(await readFile(join(checkOut(), 'check.json'), 'utf8')).not.toMatch(/"new"|description/)

      const summary = await check('--operations', detail())
      expect(summary.code).toBe(1)
      expect(summary.stdout).toContain('DRIFT GET')
      expect(summary.stdout).toContain('added: $.badge')
      expect(summary.stdout).toContain('removed: $.mrpInr')
    }
    finally {
      site.setDrift(false)
    }
  }, 120_000)

  it('keeps probe\'s safety: nothing that can change data is sent, and the host filter applies', async () => {
    const all = await check('--json')
    const report = JSON.parse(all.stdout)
    expect(report.skipped.some((entry: { reason: string }) => entry.reason.includes('--unsafe-methods'))).toBe(true)
    const login = operation('POST', '/api/auth/login').operationId
    expect(report.skipped.map((entry: { operationId: string }) => entry.operationId)).toContain(login)
    expect(report.operations.map((entry: { operationId: string }) => entry.operationId)).not.toContain(login)
    expect(report.operations.find((entry: { operationId: string }) => entry.operationId === detail())).toMatchObject({ verdict: 'ok' })
    const none = await check('--include', 'nowhere.test')
    expect(none.code).toBe(2)
  }, 180_000)

  it('exits 2 when the site cannot be reached', async () => {
    const origin = site.origin
    await site.close()
    try {
      const down = await check('--operations', detail(), '--json')
      expect(down.code).toBe(2)
      expect(JSON.parse(down.stdout).operations[0]).toMatchObject({ verdict: 'unreachable' })
    }
    finally {
      site = await startFixtureSite({
        port: Number(new URL(origin).port),
        livePriceIntervalMs: 500,
        tickIntervalMs: 300,
      })
    }
  }, 120_000)
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
    const details = docs(await readAll(cliOut()))
    expect(details).toMatch(/Cookie `_abck`: [^\n]*Needed by \d+ requests \(confirmed by probe\)/)
    expect(details).toMatch(/Cookie `bm_sz`: [^\n]*Seen in capture, but none of the \d+ requests probe tested needed it/)
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
    expect(generated).toContain('6. `client/`: typed client with Zod validation')
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
    expect(reprobed).toContain('6. `client/`: typed client with Zod validation')
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
