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
import { renderMarkdown } from '../../test/markdown'
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
  flows: [],
  computedValues: [],
}

/** A workspace with `handoff/specs/` and a `node_modules/zod` link so generated code resolves. */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-gen-'))
  await mkdir(path.join(dir, 'handoff', 'specs'), { recursive: true })
  await mkdir(path.join(dir, 'node_modules'))
  await symlink(zodDir, path.join(dir, 'node_modules', 'zod'), 'dir')
  await copyFile(fixture, path.join(dir, 'handoff', 'specs', 'shop.example.com.yaml'))
  return dir
}

// Uses the generated client the way a person would, so the strict type check below also proves
// the generated API is usable without casts.
const DRIVER = `import { CookieJar, createSiteClient, extractGetPrices, shop_example_com } from './handoff/client/index'
import type { GetPricesRecord } from './handoff/client/index'

export async function run(baseUrl: string) {
  const jar = new CookieJar()
  const site = createSiteClient({ host: 'shop.example.com', jar, baseUrl, retry: false })
  const before = await shop_example_com.getApiItem({ path: { itemId: 'a1' } })
  const login = await shop_example_com.postApiSession({ body: { username: 'demo' } })
  const item = await site.sdk.getApiItem({ path: { itemId: 'a1' }, query: { currency: 'INR' } })
  // hey-api returns a failed response validation as \`error\` instead of throwing.
  const broken = await shop_example_com.getApiItem({ path: { itemId: 'broken' } })
  const invalid = broken.error instanceof Error ? broken.error.name : 'accepted'
  const page = await shop_example_com.getPrices()
  const records: GetPricesRecord[] = typeof page.data === 'string' ? extractGetPrices(page.data) : []
  return {
    beforeStatus: before.response?.status ?? 0,
    login: login.data ?? null,
    item: item.data ?? null,
    invalid,
    records,
    cookies: jar.all().map(cookie => cookie.name),
  }
}
`

function typeCheck(files: string[]): string {
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    paths: {
      '@site-to-api/runtime': [runtimeSource],
    },
  }
  const program = ts.createProgram(files, options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
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
    if (request.method === 'POST' && request.url === '/api/session') {
      json(200, { ok: true }, {
        'set-cookie': ['session=s-123; Path=/; HttpOnly'],
      })
      return
    }
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
  login: z.unknown(),
  item: z.unknown(),
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
  })

  it('type-checks in strict mode with zero errors', () => {
    const files = [
      path.join(dir, 'driver.ts'),
      ...result.files.filter(file => file.endsWith('.ts')).map(file => path.join(dir, 'handoff', file)),
    ]
    expect(typeCheck(files)).toBe('')
  }, 60_000)

  it('the type check reports errors, so a clean result means something', async () => {
    const bad = path.join(dir, 'bad.ts')
    await writeFile(bad, `import { shop_example_com } from './handoff/client/index'\nawait shop_example_com.getApiItem({ path: { itemId: 1 } })\n`)
    expect(typeCheck([bad])).toMatch(/TS2322/)
  }, 60_000)

  it('runs against a local server: cookies, constant headers, validation and extraction', async () => {
    const driver: unknown = await import(pathToFileURL(path.join(dir, 'driver.ts')).href)
    if (typeof driver !== 'object' || driver === null || !('run' in driver) || typeof driver.run !== 'function')
      throw new Error('driver did not export run()')
    const output = DriverResultSchema.parse(await driver.run(baseUrl))

    expect(output.beforeStatus).toBe(401)
    expect(output.login).toEqual({ ok: true })
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
      expect(html.match(/<h\d>/g)).toHaveLength(4)
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
