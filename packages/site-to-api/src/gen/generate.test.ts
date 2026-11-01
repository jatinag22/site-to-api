import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FlowsDocument } from '../model'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { tickerChannel } from '../../test/channels'
import { fakeHash, graphqlGet, graphqlPost, graphqlSpecYaml } from '../../test/graphql'
import { exchange, jsonBody } from '../../test/helpers'
import { HOSTILE, injected, renderMarkdown } from '../../test/markdown'
import { buildAsyncApiDocuments } from '../emit/asyncapi'
import { toYaml } from '../emit/openapi'
import { SiteToApiError } from '../errors'
import { FLOWS_FORMAT_VERSION } from '../model'
import { generateClient, typeScriptVersionForHeyApi } from './generate'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'shop.example.com.yaml')
const runtimeSource = path.resolve(here, '../../../runtime/src/index.ts')
const zodDir = path.dirname(createRequire(import.meta.url).resolve('zod/package.json'))

const flows: FlowsDocument = {
  formatVersion: FLOWS_FORMAT_VERSION,
  generatedBy: 'test',
  sessions: ['s1'],
  session: [
    {
      host: 'shop.example.com',
      requires: 'cookies',
      cookies: [
        { name: 'session', setBy: 'postApiSession', source: 'response' },
      ],
      botProtection: [],
      probed: false,
    },
  ],
  flows: [
    {
      id: 'sign-in',
      name: 'Sign in',
      trigger: { kind: 'submit', label: 'Sign in', pageUrl: 'https://shop.example.com/login' },
      steps: [
        {
          id: 's1',
          operationId: 'getLogin',
          kind: 'page',
          browserOnly: false,
          summary: 'Login page',
          sentFrom: null,
          inputs: {},
          outputs: {},
          observedIn: [],
        },
        {
          id: 's2',
          operationId: 'postApiSession',
          kind: 'api',
          browserOnly: false,
          summary: 'Sign in',
          sentFrom: null,
          inputs: {
            'header.x-csrf-token': {
              kind: 'html',
              step: 's1',
              selector: 'meta[name="csrf-token"]',
              attr: 'content',
              pattern: null,
              confidence: 'high',
            },
          },
          outputs: {},
          observedIn: [],
        },
      ],
      seenInSessions: 1,
    },
  ],
  computedValues: [],
}

/** A workspace with `handoff/specs/` and a `node_modules/zod` link so generated code resolves. */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-gen-'))
  await mkdir(path.join(dir, 'handoff', 'specs'), { recursive: true })
  await mkdir(path.join(dir, 'node_modules'))
  await symlink(zodDir, path.join(dir, 'node_modules', 'zod'), 'dir')
  await copyFile(fixture, path.join(dir, 'handoff', 'specs', 'shop.example.com.yaml'))
  // `nodenext` treats .ts files as ES modules only inside a `"type": "module"` package.
  await writeFile(path.join(dir, 'package.json'), '{ "type": "module" }\n')
  return dir
}

// Uses the generated client the way a person would, so the strict type check below also proves
// the generated API is usable without casts.
const DRIVER = `import { CookieJar, createSiteClient, extractCsrfTokenFromGetLogin, extractGetPrices } from './handoff/client/index.js'
import type { GetPricesRecord } from './handoff/client/index.js'

export async function run(baseUrl: string) {
  const jar = new CookieJar()
  const site = createSiteClient({ host: 'shop.example.com', jar, baseUrl, retry: false, auth: () => 'Bearer t-1' })
  const before = await site.sdk.getApiItem({ path: { itemId: 'a1' } })
  const loginPage = await site.sdk.getLogin()
  const csrf = typeof loginPage.data === 'string' ? extractCsrfTokenFromGetLogin(loginPage.data) : null
  // Required headers, one of them spelled in mixed case in the spec, pass request validation.
  const login = await site.sdk.postApiSession({
    body: { username: 'demo' },
    headers: { 'x-csrf-token': csrf ?? '', 'X-Api-Version': '2' },
  })
  const item = await site.sdk.getApiItem({ path: { itemId: 'a1' }, query: { currency: 'INR' } })
  const me = await site.sdk.getApiMe()
  // hey-api returns a failed response validation as \`error\` instead of throwing.
  const broken = await site.sdk.getApiItem({ path: { itemId: 'broken' } })
  const invalid = broken.error instanceof Error ? broken.error.name : 'accepted'
  const page = await site.sdk.getPrices()
  const records: GetPricesRecord[] = typeof page.data === 'string' ? extractGetPrices(page.data) : []
  // Every call has a client of its own: another user's instance sends its own credentials and
  // cookies, one without auth sends none, and the first instance keeps its own (decision 0057).
  const otherJar = new CookieJar()
  const other = createSiteClient({ host: 'shop.example.com', jar: otherJar, baseUrl, retry: false, auth: () => 'Bearer t-2' })
  const otherMe = await other.sdk.getApiMe()
  const meWithoutAuth = await createSiteClient({ host: 'shop.example.com', baseUrl, retry: false }).sdk.getApiMe()
  const meAgain = await site.sdk.getApiMe()
  // JSON text under the site's form content type, also after the host was configured again.
  const search = await site.sdk.postApiSearch({ body: { query: 'alpha' } })
  // A content type the caller passes is sent as is (the server here answers 415 to anything but the form type).
  const ownType = await site.sdk.postApiSearch({ body: { query: 'beta' }, headers: { 'content-type': 'text/plain' } })
  return {
    beforeStatus: before.response?.status ?? 0,
    csrf,
    login: login.data ?? null,
    loginError: login.error === undefined ? null : String(login.error),
    item: item.data ?? null,
    me: me.data ?? null,
    meWithoutAuthStatus: meWithoutAuth.response?.status ?? 0,
    otherMe: otherMe.data ?? null,
    meAgain: meAgain.data ?? null,
    otherCookies: otherJar.all().map(cookie => cookie.name),
    search: search.data ?? null,
    ownTypeStatus: ownType.response?.status ?? 0,
    invalid,
    records,
    cookies: jar.all().map(cookie => cookie.name),
  }
}
`

function typeCheck(files: string[], resolution: 'bundler' | 'nodenext' = 'bundler', only?: string): string {
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: resolution === 'bundler'
      ? ts.ModuleKind.ESNext
      : ts.ModuleKind.NodeNext,
    moduleResolution: resolution === 'bundler'
      ? ts.ModuleResolutionKind.Bundler
      : ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    paths: {
      '@site-to-api/runtime': [runtimeSource],
    },
  }
  const program = ts.createProgram(files, options)
  // The runtime is checked from source here; its own imports are written for a bundler, so a
  // `nodenext` check only looks at the files under test.
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => only === undefined || (diagnostic.file?.fileName.startsWith(only) ?? true))
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  })
}

interface Seen {
  method: string
  url: string
  cookie: string | null
  requestedWith: string | null
}

const PRICES_HTML = `<html><body><table class="prices"><tbody>
<tr><td class="name">Alpha</td><td class="price">₹1,250.00</td><td><a href="/items/a1">view</a></td></tr>
<tr><td class="name">Beta</td><td class="price">99</td></tr>
</tbody></table></body></html>`

type SendJson = (status: number, body: unknown, headers?: Record<string, string | string[]>) => void

/** The login page, the CSRF-checked sign-in and the bearer-protected `/api/me`. */
function handleSignIn(request: IncomingMessage, response: ServerResponse, json: SendJson): boolean {
  if (request.url === '/login') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><head><meta name="csrf-token" content="csrf-1"></head><body></body></html>')
    return true
  }
  if (request.url === '/api/me') {
    if (request.headers.authorization === 'Bearer t-1')
      json(200, { name: 'demo' })
    else if (request.headers.authorization === 'Bearer t-2')
      json(200, { name: 'other' })
    else
      json(401, { message: 'no token' })
    return true
  }
  if (request.method === 'POST' && request.url === '/api/session') {
    if (request.headers['x-csrf-token'] === 'csrf-1' && request.headers['x-api-version'] === '2') {
      json(200, { ok: true }, {
        'set-cookie': ['session=s-123; Path=/; HttpOnly'],
      })
    }
    else {
      json(403, { message: 'csrf' })
    }
    return true
  }
  return false
}

/** Like Algolia: JSON text labelled as a form, and a 400 for anything that is not JSON. */
function handleSearch(request: IncomingMessage, json: SendJson): void {
  let text = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => {
    text += chunk
  })
  request.on('end', () => {
    let body: unknown
    try {
      body = JSON.parse(text)
    }
    catch {
      json(400, { message: 'Expecting object or array' })
      return
    }
    const form = request.headers['content-type'] === 'application/x-www-form-urlencoded'
    json(form && typeof body === 'object' && body !== null
      ? 200
      : 415, {
      hits: [
        JSON.stringify(body),
      ],
    })
  })
}

function handle(seen: Seen[]) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const cookie = request.headers.cookie ?? null
    const requestedWith = request.headers['x-requested-with']
    seen.push({
      method: request.method ?? '',
      url: request.url ?? '',
      cookie,
      requestedWith: typeof requestedWith === 'string'
        ? requestedWith
        : null,
    })
    const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}): void => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers })
      response.end(JSON.stringify(body))
    }
    if (handleSignIn(request, response, json))
      return
    if (request.url?.startsWith('/api/items/')) {
      if (cookie !== 'session=s-123') {
        json(401, { message: 'sign in first' })
        return
      }
      json(200, request.url.startsWith('/api/items/broken')
        ? { id: 1 }
        : {
            id: 'a1',
            name: 'Alpha',
            price: 1250,
            tags: ['new'],
            updatedAt: '2026-10-23T16:21:08.000-05:00',
          })
      return
    }
    if (request.method === 'POST' && request.url === '/api/search') {
      handleSearch(request, json)
      return
    }
    if (request.url === '/prices') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PRICES_HTML)
      return
    }
    json(404, {})
  }
}

const DriverResultSchema = z.object({
  beforeStatus: z.number(),
  csrf: z.string().nullable(),
  login: z.unknown(),
  loginError: z.string().nullable(),
  item: z.unknown(),
  me: z.unknown(),
  meWithoutAuthStatus: z.number(),
  otherMe: z.unknown(),
  meAgain: z.unknown(),
  otherCookies: z.array(z.string()),
  search: z.unknown(),
  ownTypeStatus: z.number(),
  invalid: z.string(),
  records: z.array(z.record(z.string(), z.unknown())),
  cookies: z.array(z.string()),
})

describe('generateClient', () => {
  let dir = ''
  let server: Server
  let baseUrl = ''
  const seen: Seen[] = []
  let result: Awaited<ReturnType<typeof generateClient>>

  beforeAll(async () => {
    dir = await workspace()
    result = await generateClient({
      handoffDir: path.join(dir, 'handoff'),
      flows,
    })
    await writeFile(path.join(dir, 'driver.ts'), DRIVER)
    server = createServer(handle(seen))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind to a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  }, 60_000)

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })

  it('writes hey-api output per host plus extract.ts, index.ts and README.md', () => {
    expect(result.warnings).toEqual([])
    expect(result.files).toEqual(expect.arrayContaining([
      'client/README.md',
      'client/extract.ts',
      'client/index.ts',
      'client/shop_example_com/client.gen.ts',
      'client/shop_example_com/index.ts',
      'client/shop_example_com/sdk.gen.ts',
      'client/shop_example_com/types.gen.ts',
      'client/shop_example_com/zod.gen.ts',
    ]))
    expect([...result.files].sort()).toEqual(result.files)
  })

  it('wires constant headers, the extract parser and the session notes', async () => {
    const site = await readFile(path.join(dir, 'handoff', 'client', 'shop_example_com', 'site.ts'), 'utf8')
    expect(site).toContain('"x-requested-with": "XMLHttpRequest"')
    expect(site).toContain('baseUrl: "https://shop.example.com"')
    const extract = await readFile(path.join(dir, 'handoff', 'client', 'extract.ts'), 'utf8')
    expect(extract).toContain('export function extractGetPrices(text: string): GetPricesRecord[]')
    expect(extract).toContain('"link": z.optional(z.nullable(z.string())),')
    const readme = await readFile(path.join(dir, 'handoff', 'client', 'README.md'), 'utf8')
    expect(readme).toContain('- Cookie `session`: set by `postApiSession` (seen in capture).')
    expect(readme).toContain('`extractGetPrices(text)` → `GetPricesRecord[]`')
    expect(extract).toContain('export function extractCsrfTokenFromGetLogin(html: string): string | null {')
    expect(readme).toContain('- Auth: `getApiMe` declare security.')
  })

  it('validates requests through the runtime, so headers are read from the Headers instance', async () => {
    const sdk = await readFile(path.join(dir, 'handoff', 'client', 'shop_example_com', 'sdk.gen.ts'), 'utf8')
    expect(sdk).toContain(`import { requestValidationInput } from '@site-to-api/runtime'`)
    expect(sdk).toMatch(/\.parseAsync\(requestValidationInput\(data, \[\s*'X-Api-Version'\s*\]\)\)/)
    expect(sdk).toContain('.parseAsync(requestValidationInput(data))')
  })

  it('type-checks with zero errors under strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes and noImplicitOverride', () => {
    const files = [
      path.join(dir, 'driver.ts'),
      ...result.files.filter(file => file.endsWith('.ts')).map(file => path.join(dir, 'handoff', file)),
    ]
    expect(typeCheck(files)).toBe('')
  }, 60_000)

  it('type-checks under moduleResolution nodenext, with .js specifiers throughout', async () => {
    // The driver is left out: with the runtime checked from source its types degrade under
    // `nodenext`. e2e/pipeline.test.ts checks a driver against the built runtime.
    const files = result.files.filter(file => file.endsWith('.ts')).map(file => path.join(dir, 'handoff', file))
    expect(typeCheck(files, 'nodenext', path.join(dir, 'handoff'))).toBe('')
    for (const file of result.files.filter(name => name.endsWith('.ts'))) {
      const source = await readFile(path.join(dir, 'handoff', file), 'utf8')
      for (const [, specifier] of source.matchAll(/from '(\.[^']*)'/g))
        expect(specifier, file).toMatch(/\.js$/)
    }
  }, 60_000)

  it('the type check reports errors, so a clean result means something', async () => {
    const bad = path.join(dir, 'bad.ts')
    await writeFile(bad, `import { shop_example_com } from './handoff/client/index.js'\nawait shop_example_com.getApiItem({ path: { itemId: 1 } })\n`)
    expect(typeCheck([bad])).toMatch(/TS2322/)
  }, 60_000)

  it('runs against a local server: cookies, constant headers, validation and extraction', async () => {
    const driver: unknown = await import(pathToFileURL(path.join(dir, 'driver.ts')).href)
    if (typeof driver !== 'object' || driver === null || !('run' in driver) || typeof driver.run !== 'function')
      throw new Error('driver did not export run()')
    const output = DriverResultSchema.parse(await driver.run(baseUrl))

    expect(output.beforeStatus).toBe(401)
    expect(output.csrf).toBe('csrf-1')
    expect(output.loginError).toBeNull()
    expect(output.login).toEqual({ ok: true })
    expect(output.me).toEqual({ name: 'demo' })
    expect(output.meWithoutAuthStatus).toBe(401)
    expect(output.otherMe).toEqual({ name: 'other' })
    expect(output.meAgain).toEqual({ name: 'demo' })
    expect(output.otherCookies).toEqual([])
    expect(output.search).toEqual({
      hits: ['{"query":"alpha"}'],
    })
    expect(output.ownTypeStatus).toBe(415)
    expect(output.item).toEqual({
      id: 'a1',
      name: 'Alpha',
      price: 1250,
      tags: ['new'],
      // An offset, not `Z`: response validation must accept it.
      updatedAt: '2026-10-23T16:21:08.000-05:00',
    })
    // Zod Mini's error class (decision 0057).
    expect(output.invalid).toBe('$ZodError')
    expect(output.cookies).toEqual(['session'])
    expect(output.records).toEqual([
      { name: 'Alpha', price: 1250, link: '/items/a1' },
      { name: 'Beta', price: 99 },
    ])

    const item = seen.find(entry => entry.url === '/api/items/a1?currency=INR')
    expect(item).toMatchObject({ method: 'GET', cookie: 'session=s-123', requestedWith: 'XMLHttpRequest' })
    expect(seen[0]).toMatchObject({ url: '/api/items/a1', cookie: null })
  })

  it('produces byte-identical output for the same specs', async () => {
    const again = await workspace()
    try {
      const second = await generateClient({
        handoffDir: path.join(again, 'handoff'),
        flows,
      })
      expect(second.files).toEqual(result.files)
      for (const file of result.files) {
        const [a, b] = await Promise.all([
          readFile(path.join(dir, 'handoff', file), 'utf8'),
          readFile(path.join(again, 'handoff', file), 'utf8'),
        ])
        expect(b, file).toBe(a)
      }
    }
    finally {
      await rm(again, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('generateClient into gen.clientDir (decision 0057)', () => {
  it('writes the client outside the handoff folder, keeps the person\'s files and names real paths', async () => {
    const dir = await workspace()
    try {
      const handoff = path.join(dir, 'handoff')
      const clientDir = path.join(dir, 'src', 'api')
      await mkdir(clientDir, { recursive: true })
      await writeFile(path.join(clientDir, 'mine.ts'), 'export const mine = 1\n')
      const first = await generateClient({
        handoffDir: handoff,
        clientDir,
        root: dir,
        flows,
      })
      expect(first.files).toContain('../src/api/index.ts')
      expect(first.files).not.toContain('../src/api/mine.ts')
      expect(existsSync(path.join(handoff, 'client'))).toBe(false)
      const readme = await readFile(path.join(clientDir, 'README.md'), 'utf8')
      expect(readme).toContain('Generated from `../../handoff/specs/` and `../../handoff/flows.json` (the handoff folder `handoff/`)')
      expect(readme).toContain('`src/api/index.js` from the project root')
      // A hand edit is kept and reported; --force overwrites it; the person's file stays.
      const index = await readFile(path.join(clientDir, 'index.ts'), 'utf8')
      await writeFile(path.join(clientDir, 'index.ts'), `${index}// mine\n`)
      const second = await generateClient({
        handoffDir: handoff,
        clientDir,
        root: dir,
        flows,
        previous: first.manifest,
      })
      expect(second.warnings.join('\n')).toContain('Kept 1 client file(s) edited by hand instead of regenerating them: index.ts.')
      expect(await readFile(path.join(clientDir, 'index.ts'), 'utf8')).toBe(`${index}// mine\n`)
      await generateClient({
        handoffDir: handoff,
        clientDir,
        root: dir,
        flows,
        previous: second.manifest,
        force: true,
      })
      expect(await readFile(path.join(clientDir, 'index.ts'), 'utf8')).toBe(index)
      expect(await readFile(path.join(clientDir, 'mine.ts'), 'utf8')).toBe('export const mine = 1\n')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('generateClient with gen.mcpDir (decision 0057)', () => {
  it('refuses an MCP folder inside the client folder', async () => {
    const dir = await workspace()
    try {
      const handoff = path.join(dir, 'handoff')
      await expect(generateClient({
        handoffDir: handoff,
        flows,
        mcp: 'read',
        mcpDir: path.join(handoff, 'client', 'mcp'),
      }))
        .rejects
        .toThrow(/is inside the client folder .*Set gen\.mcpDir to a folder outside it/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('generateClient and bot-protection steps', () => {
  it('generates no client method or folder for bot-protection steps', async () => {
    const dir = await workspace()
    try {
      const specs = path.join(dir, 'handoff', 'specs')
      const fixtureText = await readFile(fixture, 'utf8')
      await writeFile(path.join(specs, 'shop.example.com.yaml'), fixtureText.replace('paths:\n', `paths:
  /a1b2/c3d4/mfc:
    get:
      operationId: getA1b2C3d4Mfc
      x-site-to-api-kind: bot-protection
      responses:
        '200':
          description: OK
`))
      await writeFile(path.join(specs, 'abc.token.awswaf.com.yaml'), `openapi: 3.1.0
info: { title: t, version: '1' }
servers: [{ url: 'https://abc.token.awswaf.com' }]
paths:
  /a/b/c/inputs:
    get:
      operationId: getABCInputs
      x-site-to-api-kind: bot-protection
      responses:
        '200':
          description: OK
`)
      const result = await generateClient({
        handoffDir: path.join(dir, 'handoff'),
        flows,
      })
      expect(result.files.some(file => file.includes('awswaf'))).toBe(false)
      const sdk = await readFile(path.join(dir, 'handoff', 'client', 'shop_example_com', 'sdk.gen.ts'), 'utf8')
      expect(sdk).toContain('postApiSession')
      expect(sdk).not.toContain('Mfc')
      const index = await readFile(path.join(dir, 'handoff', 'client', 'index.ts'), 'utf8')
      expect(index).not.toContain('awswaf')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
  it('writes no client, and removes an old one, when every operation is a bot-protection step', async () => {
    const dir = await workspace()
    try {
      const handoff = path.join(dir, 'handoff')
      await writeFile(path.join(handoff, 'specs', 'shop.example.com.yaml'), `openapi: 3.1.0
info: { title: t, version: '1' }
servers: [{ url: 'https://shop.example.com' }]
paths:
  /a1b2/c3d4/mfc:
    get:
      operationId: getA1b2C3d4Mfc
      x-site-to-api-kind: bot-protection
      responses:
        '200':
          description: OK
`)
      await mkdir(path.join(handoff, 'client'), { recursive: true })
      await writeFile(path.join(handoff, 'client', 'index.ts'), 'const sdks = {}\n')
      const previous = {
        'index.ts': createHash('sha256').update('const sdks = {}\n').digest('hex'),
      }
      const result = await generateClient({ handoffDir: handoff, flows, previous })
      expect(result).toEqual({
        files: [],
        warnings: [],
        empty: true,
        manifest: {},
        mcpManifest: {},
      })
      await expect(readFile(path.join(handoff, 'client', 'index.ts'), 'utf8')).rejects.toThrow()
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('generateClient errors', () => {
  it('asks for build when there are no specs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-gen-'))
    try {
      await expect(generateClient({ handoffDir: dir, flows })).rejects.toThrow(/run `site-to-api build` first/)
      await mkdir(path.join(dir, 'specs'))
      await expect(generateClient({ handoffDir: dir, flows })).rejects.toThrow(/No .yaml specs/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid YAML and documents that are not OpenAPI', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-gen-'))
    try {
      await mkdir(path.join(dir, 'specs'))
      await writeFile(path.join(dir, 'specs', 'a.example.yaml'), 'openapi: [unclosed')
      await expect(generateClient({ handoffDir: dir, flows })).rejects.toBeInstanceOf(SiteToApiError)
      await writeFile(path.join(dir, 'specs', 'a.example.yaml'), 'title: not openapi\n')
      await expect(generateClient({ handoffDir: dir, flows })).rejects.toThrow(/is not an OpenAPI document/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects two specs for the same client folder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-gen-'))
    try {
      await mkdir(path.join(dir, 'specs'))
      const spec = (host: string): string => `openapi: 3.1.0\ninfo: { title: t, version: '1' }\nservers: [{ url: 'https://${host}' }]\npaths: {}\n`
      await writeFile(path.join(dir, 'specs', 'a.yaml'), spec('a-b.example'))
      await writeFile(path.join(dir, 'specs', 'b.yaml'), spec('a.b.example'))
      await expect(generateClient({ handoffDir: dir, root: dir, flows })).rejects.toThrow(/both map to client\/a_b_example\//)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** Generates a client from one fixture spec into a fresh workspace and returns its directory. */
async function generateFrom(fixtureName: string): Promise<{ dir: string, result: Awaited<ReturnType<typeof generateClient>> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-gen-'))
  await mkdir(path.join(dir, 'handoff', 'specs'), { recursive: true })
  await mkdir(path.join(dir, 'node_modules'))
  await symlink(zodDir, path.join(dir, 'node_modules', 'zod'), 'dir')
  await copyFile(path.join(here, 'fixtures', fixtureName), path.join(dir, 'handoff', 'specs', fixtureName))
  const result = await generateClient({
    handoffDir: path.join(dir, 'handoff'),
    flows,
  })
  return { dir, result }
}

interface ParsedFile {
  /** Syntax errors only: the parser's own diagnostics, no type checking. */
  errors: string[]
  /** Kinds of the top-level statements, e.g. `VariableStatement`. */
  statements: string[]
}

async function parseGenerated(dir: string, files: string[], identifier: string): Promise<Map<string, ParsedFile>> {
  const parsed = new Map<string, ParsedFile>()
  for (const file of files.filter(name => name.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, await readFile(path.join(dir, 'handoff', file), 'utf8'), ts.ScriptTarget.ES2023, false, ts.ScriptKind.TS)
    // A one-file program reports exactly the syntax errors of that file.
    const program = ts.createProgram({
      rootNames: [file],
      options: { noResolve: true, noLib: true, types: [] },
      host: {
        ...ts.createCompilerHost({}),
        getSourceFile: name => name === file
          ? source
          : undefined,
        fileExists: name => name === file,
        writeFile: () => {},
      },
    })
    parsed.set(file.replace(identifier, 'HOST'), {
      errors: program.getSyntacticDiagnostics(source).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      statements: source.statements.map(statement => ts.SyntaxKind[statement.kind]),
    })
  }
  return parsed
}

describe('generateClient with hostile specs', () => {
  it('writes no syntax errors and no extra statements when site strings try to break out', async () => {
    const hostile = await generateFrom('hostile.example.yaml')
    const benign = await generateFrom('benign.example.yaml')
    try {
      const hostileFiles = await parseGenerated(hostile.dir, hostile.result.files, 'h_o_s_t_q_x_example')
      const benignFiles = await parseGenerated(benign.dir, benign.result.files, 'benign_example')
      expect([
        ...hostileFiles.keys(),
      ].sort()).toEqual([
        ...benignFiles.keys(),
      ].sort())
      for (const [file, parsed] of hostileFiles) {
        expect(parsed.errors, file).toEqual([])
        expect(parsed.statements, file).toEqual(benignFiles.get(file)?.statements)
      }
      // The payload is still there, as data: inside comments and string literals only.
      const extract = await readFile(path.join(hostile.dir, 'handoff', 'client', 'extract.ts'), 'utf8')
      expect(extract).toContain('globalThis.pwned')
      expect(extract).not.toMatch(/[\u2028\u2029]/)
    }
    finally {
      await Promise.all([hostile.dir, benign.dir].map(dir => rm(dir, { recursive: true, force: true })))
    }
  }, 60_000)

  it('writes a README whose code block and spans the site strings cannot close', async () => {
    const { dir, result } = await generateFrom('hostile.example.yaml')
    try {
      const readme = await readFile(path.join(dir, 'handoff', 'client', 'README.md'), 'utf8')
      const html = renderMarkdown(readme)
      // Two code blocks and ten headings: the README's own, plus what to commit, deploy targets and small bundles.
      expect(html.match(/<pre>/g)).toHaveLength(2)
      expect(html.match(/<h\d>/g)).toHaveLength(10)
      expect(result.files).toContain('client/README.md')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('typeScriptVersionForHeyApi', () => {
  it('resolves TypeScript 6 for hey-api', () => {
    expect(typeScriptVersionForHeyApi()).toMatch(/^6\./)
  })
})

describe('generateClient with WebSocket channels', () => {
  const asyncApi = (channel = tickerChannel({ host: 'shop.example.com' })): string =>
    toYaml(buildAsyncApiDocuments([channel], 1).get(channel.host) ?? {})

  it('leaves AsyncAPI documents to the README and generates the HTTP client as before', async () => {
    const dir = await workspace()
    try {
      await writeFile(path.join(dir, 'handoff', 'specs', 'shop.example.com.asyncapi.yaml'), asyncApi())
      const result = await generateClient({
        handoffDir: path.join(dir, 'handoff'),
        flows,
      })
      expect(result.warnings).toEqual([])
      expect(result.files.filter(file => file.includes('asyncapi'))).toEqual([])
      const readme = await readFile(path.join(dir, 'handoff', 'client', 'README.md'), 'utf8')
      expect(readme).toContain('## Real-time channels')
      expect(readme).toContain('- `ws://shop.example.com/ws/ticker` (channel `wsTicker` in `../specs/shop.example.com.asyncapi.yaml`): after connecting, send `subscribe` to subscribe (`{"type":"subscribe","productId":1007}`).')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('escapes channel text from the site in the README', async () => {
    const dir = await workspace()
    try {
      const channel = tickerChannel({
        host: 'shop.example.com',
        path: `/ws/${HOSTILE}`,
        handshake: [
          { message: 'sendSubscribe', role: 'subscribe', example: HOSTILE },
        ],
      })
      await writeFile(path.join(dir, 'handoff', 'specs', 'shop.example.com.asyncapi.yaml'), asyncApi(channel))
      await generateClient({
        handoffDir: path.join(dir, 'handoff'),
        flows,
      })
      const readme = await readFile(path.join(dir, 'handoff', 'client', 'README.md'), 'utf8')
      expect(injected(renderMarkdown(readme))).toEqual([])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('still asks for build when the only specs are AsyncAPI, and warns about unreadable ones', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-gen-'))
    try {
      await mkdir(path.join(dir, 'specs'))
      await writeFile(path.join(dir, 'specs', 'shop.example.com.asyncapi.yaml'), asyncApi())
      await expect(generateClient({ handoffDir: dir, flows })).rejects.toThrow(/No .yaml specs/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
    const work = await workspace()
    try {
      await writeFile(path.join(work, 'handoff', 'specs', 'broken.asyncapi.yaml'), 'asyncapi: 3.0.0\nchannels: 3\n')
      const result = await generateClient({
        handoffDir: path.join(work, 'handoff'),
        flows,
      })
      expect(result.warnings.some(warning => warning.startsWith('specs/broken.asyncapi.yaml looks like AsyncAPI but could not be read'))).toBe(true)
    }
    finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('generateClient with GraphQL operations (decision 0027)', () => {
  const HOST = 'api.example.test'
  const HASH = fakeHash('9a')
  const MUTATION = 'mutation AddToWishlist($productId: Int!) { addToWishlist(productId: $productId) { count } }'
  const spec = (): string => graphqlSpecYaml([
    graphqlPost({
      operationName: 'queryArtistOverview',
      variables: { uri: 'spotify:artist:1' },
      hash: HASH,
      data: {
        artistUnion: { name: 'A' },
      },
    }),
    graphqlPost({
      operationName: 'queryArtistOverview',
      variables: { uri: 'spotify:artist:2' },
      hash: HASH,
      data: {
        artistUnion: { name: 'B' },
      },
      sessionId: 's2',
    }),
    graphqlGet({
      operationName: 'StoreHours',
      variables: { slug: 'pine-hill' },
      hash: HASH,
      extraQuery: { locale: 'en' },
      data: {
        storeHours: { opens: '08:00' },
      },
    }),
    graphqlPost({
      query: MUTATION,
      variables: { productId: 1001 },
      data: {
        addToWishlist: { count: 1 },
      },
    }),
    graphqlPost({
      path: `/api/v3/Header/${HASH}`,
      operationName: 'Header',
      variables: {},
      hash: HASH,
      data: {
        header: { title: 'x' },
      },
    }),
  ], HOST)

  const GRAPHQL_DRIVER = `import { createSiteClient } from './handoff/client/index.js'

export async function run(baseUrl: string) {
  const { sdk } = createSiteClient({ host: '${HOST}', baseUrl, retry: false })
  const artist = await sdk.queryArtistOverview({ variables: { uri: 'spotify:artist:9' } })
  const hours = await sdk.storeHours({ variables: { slug: 'cedar-park' }, query: { locale: 'en' } })
  const added = await sdk.addToWishlist({ variables: { productId: 1002 } })
  const header = await sdk.header({ variables: {} })
  return {
    artist: artist.data?.data.artistUnion.name ?? null,
    // One sample each: their response fields are not promised (decision 0034).
    hours: hours.data?.data?.storeHours?.opens ?? null,
    added: added.data?.data?.addToWishlist?.count ?? null,
    header: header.data?.data?.header?.title ?? null,
  }
}
`

  it('sends the constants of each operation, the variables as JSON, and goes to the endpoint, not the #name path', async () => {
    const dir = await workspace()
    const seen: Array<{ method: string, url: string, body: string }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        seen.push({ method: request.method ?? '', url: request.url ?? '', body })
        const url = new URL(request.url ?? '/', 'http://localhost')
        const parsed: unknown = body === ''
          ? null
          : JSON.parse(body)
        const name = url.searchParams.get('operationName')
          ?? (parsed !== null && typeof parsed === 'object' && 'operationName' in parsed
            ? parsed.operationName
            : null)
        const data = url.pathname.startsWith('/api/v3/Header/')
          ? {
              header: { title: 'Home' },
            }
          : name === 'queryArtistOverview'
            ? {
                artistUnion: { name: 'Artist' },
              }
            : name === 'StoreHours'
              ? {
                  storeHours: { opens: '09:00' },
                }
              : {
                  addToWishlist: { count: 2 },
                }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await rm(path.join(dir, 'handoff', 'specs', 'shop.example.com.yaml'))
      await writeFile(path.join(dir, 'handoff', 'specs', `${HOST}.yaml`), spec())
      const result = await generateClient({
        handoffDir: path.join(dir, 'handoff'),
        flows,
      })
      expect(result.warnings).toEqual([])
      expect(result.files).toContain('client/api_example_test/graphql.ts')
      await writeFile(path.join(dir, 'driver.ts'), GRAPHQL_DRIVER)
      const files = [
        path.join(dir, 'driver.ts'),
        ...result.files.filter(file => file.endsWith('.ts')).map(file => path.join(dir, 'handoff', file)),
      ]
      expect(typeCheck(files)).toBe('')
      expect(typeCheck(files.slice(1), 'nodenext', path.join(dir, 'handoff'))).toBe('')
      // Variables are required and typed from the capture.
      await writeFile(path.join(dir, 'bad.ts'), `import { createSiteClient } from './handoff/client/index.js'\nawait createSiteClient({ host: '${HOST}' }).sdk.queryArtistOverview({ variables: { uri: 1 } })\n`)
      expect(typeCheck([
        path.join(dir, 'bad.ts'),
      ])).toMatch(/TS2322/)

      const address = server.address()
      if (address === null || typeof address === 'string')
        throw new Error('test server did not bind to a TCP port')
      const driver: unknown = await import(pathToFileURL(path.join(dir, 'driver.ts')).href)
      if (typeof driver !== 'object' || driver === null || !('run' in driver) || typeof driver.run !== 'function')
        throw new Error('driver did not export run()')
      expect(await driver.run(`http://127.0.0.1:${address.port}`)).toEqual({
        artist: 'Artist',
        hours: '09:00',
        added: 2,
        header: 'Home',
      })

      expect(seen.map(entry => `${entry.method} ${new URL(entry.url, 'http://localhost').pathname}`)).toEqual([
        'POST /graphql',
        'GET /graphql',
        'POST /graphql',
        `POST /api/v3/Header/${HASH}`,
      ])
      expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
        operationName: 'queryArtistOverview',
        variables: { uri: 'spotify:artist:9' },
        extensions: {
          persistedQuery: { version: 1, sha256Hash: HASH },
        },
      })
      const get = new URL(seen[1]?.url ?? '', 'http://localhost').searchParams
      expect(Object.fromEntries(get)).toEqual({
        locale: 'en',
        operationName: 'StoreHours',
        variables: JSON.stringify({ slug: 'cedar-park' }),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: HASH },
        }),
      })
      expect(JSON.parse(seen[2]?.body ?? '')).toEqual({
        query: MUTATION,
        variables: { productId: 1002 },
      })

      const readme = await readFile(path.join(dir, 'handoff', 'client', 'README.md'), 'utf8')
      expect(readme).toContain('- GraphQL on `POST /graphql`: `sdk.addToWishlist({ variables })` (mutation), `sdk.queryArtistOverview({ variables })` (unknown).')
      expect(readme).toContain('- GraphQL on `GET /graphql`: `sdk.storeHours({ variables })` (query).')
    }
    finally {
      await new Promise(resolve => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('generateClient with dispatcher functions (decision 0039)', () => {
  const HOST = 'api.example.test'
  // Values that are reserved words in strict mode or names dispatch.ts declares itself.
  const VALUES = [
    'sdk',
    'fetchWithoutFragment',
    'client',
    'options',
    'rest',
    'static',
    'let',
    'await',
    'eval',
    'arguments',
    'interface',
    'package',
    'private',
    'protected',
    'public',
    'implements',
    'getQuote',
    'user/get',
    'user:list',
  ]

  it('writes a dispatch.ts that type-checks whatever the values are called', async () => {
    const dir = await workspace()
    try {
      await rm(path.join(dir, 'handoff', 'specs', 'shop.example.com.yaml'))
      await writeFile(path.join(dir, 'handoff', 'specs', `${HOST}.yaml`), graphqlSpecYaml(VALUES.map((value, index) => exchange({
        url: `https://${HOST}/api/ajax?action=${encodeURIComponent(value)}`,
        responseBody: jsonBody({
          [`field${index}`]: { [`inner${index}`]: index },
        }),
      })), HOST))
      const result = await generateClient({
        handoffDir: path.join(dir, 'handoff'),
        flows,
      })
      expect(result.warnings).toEqual([])
      const dispatch = await readFile(path.join(dir, 'handoff', 'client', 'api_example_test', 'dispatch.ts'), 'utf8')
      expect(dispatch).toContain('export function getApiAjaxStatic<')
      expect(dispatch).toContain('export function getApiAjaxSdk<')
      expect(dispatch).toContain('export function getQuote<')
      expect(dispatch).toContain('export function userGet<')
      await writeFile(path.join(dir, 'driver.ts'), `import { createSiteClient } from './handoff/client/index.js'\nexport const call = () => createSiteClient({ host: '${HOST}' }).sdk.getApiAjaxStatic()\n`)
      const files = [
        path.join(dir, 'driver.ts'),
        ...result.files.filter(file => file.endsWith('.ts')).map(file => path.join(dir, 'handoff', file)),
      ]
      expect(typeCheck(files)).toBe('')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
