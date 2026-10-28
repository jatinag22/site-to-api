import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FlowsDocument } from '../model'
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
const DRIVER = `import { CookieJar, createSiteClient, extractCsrfTokenFromGetLogin, extractGetPrices, shop_example_com } from './handoff/client/index.js'
import type { GetPricesRecord } from './handoff/client/index.js'

export async function run(baseUrl: string) {
  const jar = new CookieJar()
  const site = createSiteClient({ host: 'shop.example.com', jar, baseUrl, retry: false, auth: () => 'Bearer t-1' })
  const before = await shop_example_com.getApiItem({ path: { itemId: 'a1' } })
  const loginPage = await site.sdk.getLogin()
  const csrf = typeof loginPage.data === 'string' ? extractCsrfTokenFromGetLogin(loginPage.data) : null
  // Required headers, one of them spelled in mixed case in the spec, pass request validation.
  const login = await shop_example_com.postApiSession({
    body: { username: 'demo' },
    headers: { 'x-csrf-token': csrf ?? '', 'X-Api-Version': '2' },
  })
  const item = await site.sdk.getApiItem({ path: { itemId: 'a1' }, query: { currency: 'INR' } })
  const me = await site.sdk.getApiMe()
  // hey-api returns a failed response validation as \`error\` instead of throwing.
  const broken = await shop_example_com.getApiItem({ path: { itemId: 'broken' } })
  const invalid = broken.error instanceof Error ? broken.error.name : 'accepted'
  const page = await shop_example_com.getPrices()
  const records: GetPricesRecord[] = typeof page.data === 'string' ? extractGetPrices(page.data) : []
  // A second configuration for the same host replaces the first one, \`auth\` included.
  createSiteClient({ host: 'shop.example.com', jar, baseUrl, retry: false })
  const meWithoutAuth = await site.sdk.getApiMe()
  return {
    beforeStatus: before.response?.status ?? 0,
    csrf,
    login: login.data ?? null,
    loginError: login.error === undefined ? null : String(login.error),
    item: item.data ?? null,
    me: me.data ?? null,
    meWithoutAuthStatus: meWithoutAuth.response?.status ?? 0,
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
          })
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
    const index = await readFile(path.join(dir, 'handoff', 'client', 'index.ts'), 'utf8')
    expect(index).toContain('"x-requested-with": "XMLHttpRequest"')
    expect(index).toContain('baseUrl: "https://shop.example.com"')
    const extract = await readFile(path.join(dir, 'handoff', 'client', 'extract.ts'), 'utf8')
    expect(extract).toContain('export function extractGetPrices(text: string): GetPricesRecord[]')
    expect(extract).toContain('"link": z.string().nullable().optional(),')
    const readme = await readFile(path.join(dir, 'handoff', 'client', 'README.md'), 'utf8')
    expect(readme).toContain('Cookies the API needs: `session` (set by `postApiSession`)')
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

  it('type-checks in strict mode with zero errors', () => {
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
    expect(output.item).toEqual({
      id: 'a1',
      name: 'Alpha',
      price: 1250,
      tags: ['new'],
    })
    expect(output.invalid).toBe('ZodError')
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
      await expect(generateClient({ handoffDir: dir, flows })).rejects.toThrow(/both map to client\/a_b_example\//)
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
      expect(html.match(/<pre>/g)).toHaveLength(1)
      expect(html.match(/<h\d>/g)).toHaveLength(7)
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
      expect(readme).toContain('- `ws://shop.example.com/ws/ticker` (channel `wsTicker` in `../specs/shop.example.com.asyncapi.yaml`): after connecting, send `subscribe` (`{"type":"subscribe","productId":1007}`).')
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
          { message: 'sendSubscribe', example: HOSTILE },
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
