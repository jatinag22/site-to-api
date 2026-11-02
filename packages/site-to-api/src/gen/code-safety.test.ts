import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { shopFlows, writeShopHandoff } from '../../test/handoff'
import { HOSTILE, HOSTILE_PATTERNS, hostileShopSpec, PWN } from '../../test/hostile-spec'
import { toYaml } from '../emit/openapi'
import { checkGeneratedCode, heyApiInput } from './code-safety'
import { generateClient } from './generate'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function files(dir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile())
      result.set(path.relative(dir, path.join(entry.parentPath, entry.name)), await readFile(path.join(entry.parentPath, entry.name), 'utf8'))
  }
  return result
}

/** Every place `text` occurs in TypeScript code outside a string literal or a comment. */
function inCode(file: string, text: string, needle: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
  const hits: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isLiteralTypeNode(node))
      return
    if (node.getChildCount(source) === 0 && node.getText(source).includes(needle))
      hits.push(`${ts.SyntaxKind[node.kind]}: ${node.getText(source).slice(0, 60)}`)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

/** The comments of a TypeScript file, found by the scanner (a regex would match inside strings). */
function comments(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2023, false, ts.LanguageVariant.Standard, text)
  const found: string[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.MultiLineCommentTrivia || token === ts.SyntaxKind.SingleLineCommentTrivia)
      found.push(scanner.getTokenText())
  }
  return found
}

describe('heyApiInput', () => {
  it('drops patterns, documentation, examples and extensions, but not fields with those names', () => {
    expect(heyApiInput({
      info: { title: 'x', version: '1', description: 'd' },
      paths: {
        '/a': {
          get: {
            'summary': 's',
            'x-site-to-api-kind': 'api',
            'parameters': [
              {
                name: 'q',
                in: 'query',
                description: 'd',
                example: 'e',
                schema: {
                  type: 'string',
                  pattern: '^a$',
                  default: 'v',
                  enum: ['v'],
                },
              },
            ],
            'responses': {
              200: {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        description: { type: 'string', title: 't' },
                        pattern: { type: 'string' },
                      },
                    },
                    examples: {},
                  },
                },
              },
            },
          },
        },
      },
    })).toEqual({
      info: { version: '1' },
      paths: {
        '/a': {
          get: {
            parameters: [
              {
                name: 'q',
                in: 'query',
                schema: {
                  type: 'string',
                  default: 'v',
                  enum: ['v'],
                },
              },
            ],
            responses: {
              200: {
                description: '',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        description: { type: 'string' },
                        pattern: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })
  })
})

describe('generateClient with a hostile spec', () => {
  let dir = ''
  let generated = new Map<string, string>()

  beforeAll(async () => {
    dir = await writeShopHandoff()
    dirs.push(dir)
    await writeFile(path.join(dir, 'specs', 'shop.example.com.yaml'), toYaml(hostileShopSpec()))
    await generateClient({ handoffDir: dir, flows: shopFlows, mcp: 'write' })
    generated = await files(path.join(dir, 'client'))
  }, 60_000)

  it('writes no pattern and no regex validation at all', () => {
    for (const [file, text] of generated) {
      expect(text, file).not.toContain('.regex(')
      for (const pattern of HOSTILE_PATTERNS.slice(0, 6))
        expect(text, file).not.toContain(pattern)
    }
  })

  it('keeps every other hostile value inside string literals, and passes the parse and regex check', async () => {
    for (const [file, text] of generated) {
      if (file.endsWith('.ts'))
        expect(inCode(file, text, PWN), file).toEqual([])
    }
    // Documentation never reaches the code: no JSDoc carries the hostile text.
    for (const [file, text] of generated) {
      if (file.endsWith('.ts'))
        expect(comments(text).filter(comment => comment.includes(PWN)), file).toEqual([])
    }
    await expect(checkGeneratedCode(path.join(dir, 'client'))).resolves.toBeUndefined()
  })

  it('loads without running the payload', async () => {
    const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runtime/src/index.ts')
    const zod = path.dirname(createRequire(import.meta.url).resolve('zod/package.json'))
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { 'site-to-api-runtime': runtime, zod },
    })
    const client: unknown = await jiti.import(path.join(dir, 'client', 'index.ts'))
    expect(typeof client).toBe('object')
    expect(Reflect.get(globalThis, '__pwn')).toBeUndefined()
    expect(HOSTILE).toContain(PWN)
  }, 60_000)
})

describe('checkGeneratedCode', () => {
  async function folder(entries: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-code-'))
    dirs.push(dir)
    for (const [name, text] of Object.entries(entries)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await writeFile(path.join(dir, name), text)
    }
    return dir
  }

  it('accepts hey-api\'s own template regexes in core/', async () => {
    await expect(checkGeneratedCode(await folder({ 'host/core/utils.gen.ts': 'export const a = /\\{[^{}]+\\}/g\n' }))).resolves.toBeUndefined()
  })

  it('fails on any other regex literal, in hey-api\'s files or ours', async () => {
    for (const [name, text] of [
      ['host/zod.gen.ts', `export const a = z.string().regex(/a/, ${PWN}, /b/)\n`],
      ['host/core/utils.gen.ts', 'export const a = /x/\n'],
      ['index.ts', 'export const a = /x/\n'],
      ['mcp/server.ts', 'export const a = /x/\n'],
    ] as const)
      await expect(checkGeneratedCode(await folder({ [name]: text })), name).rejects.toThrow(/regular expression/)
  })

  it('fails on a file that does not parse, ours included', async () => {
    for (const name of [
      'host/sdk.gen.ts',
      'extract.ts',
      'host/graphql.ts',
      'host/dispatch.ts',
    ])
      await expect(checkGeneratedCode(await folder({ [name]: 'export const a = (\n' })), name).rejects.toThrow(/does not parse/)
  })
})
