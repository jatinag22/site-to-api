import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shopFlows, shopSpec, writeShopHandoff } from '../../test/handoff'
import { toYaml } from '../emit/openapi'
import { generateClient } from './generate'
import { checkGeneratedCode, unsafePattern, withSafePatterns } from './patterns'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** The reviewer's payloads: each one broke hey-api's regex literal. */
const HOSTILE = [
  '*x',
  'a\\\\/b',
  '^a/b$',
  'x/ ; globalThis.pwned = 1; /',
  'a\nb',
  '(unclosed',
]

describe('unsafePattern', () => {
  it('keeps ordinary patterns and refuses the ones that break a regex literal', () => {
    expect(unsafePattern('^[A-Z]{3}-\\d+$')).toBeNull()
    expect(unsafePattern('^\\*+$')).toBeNull()
    for (const pattern of HOSTILE)
      expect(unsafePattern(pattern), pattern).not.toBeNull()
  })
})

describe('withSafePatterns', () => {
  it('drops unsafe patterns with a warning, and leaves field names and extensions alone', () => {
    const warnings: string[] = []
    const { document, patterns } = withSafePatterns({
      'schema': {
        type: 'object',
        properties: {
          pattern: { type: 'string', pattern: '^ok$' },
          bad: { type: 'string', pattern: '*x' },
        },
      },
      'x-site-to-api-extract': { pattern: '*not a schema' },
    }, 'specs/a.yaml', warnings)
    expect([...patterns]).toEqual(['^ok$'])
    expect(document).toEqual({
      'schema': {
        type: 'object',
        properties: {
          pattern: { type: 'string', pattern: '^ok$' },
          bad: { type: 'string' },
        },
      },
      'x-site-to-api-extract': { pattern: '*not a schema' },
    })
    expect(warnings).toEqual(['specs/a.yaml: dropped the pattern "*x" because it starts with `*`, which would open a comment; the generated schema accepts any string there'])
  })
})

describe('generateClient with hostile patterns', () => {
  it('drops them, keeps validation for the rest, and writes code that parses', async () => {
    const dir = await writeShopHandoff()
    dirs.push(dir)
    const spec = shopSpec()
    const properties = Object.fromEntries([...HOSTILE, '^[A-Z]{3}-\\d+$'].map((pattern, index) => [
      `p${index}`,
      { type: 'string', pattern },
    ]))
    const paths = Reflect.get(spec, 'paths')
    Reflect.set(paths, '/api/evil', {
      get: {
        operationId: 'getEvil',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'object', properties },
              },
            },
          },
        },
      },
    })
    await writeFile(path.join(dir, 'specs', 'shop.example.com.yaml'), toYaml(spec))
    const result = await generateClient({ handoffDir: dir, flows: shopFlows })
    expect(result.warnings.filter(warning => warning.includes('dropped the pattern'))).toHaveLength(HOSTILE.length)
    const zod = await readFile(path.join(dir, 'client', 'shop_example_com', 'zod.gen.ts'), 'utf8')
    expect(zod).toContain('p6: z.string().regex(/^[A-Z]{3}-\\d+$/).optional()')
    expect(zod).toContain('p0: z.string().optional()')
    expect(zod).not.toContain('pwned')
  }, 60_000)
})

describe('checkGeneratedCode', () => {
  async function folder(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-patterns-'))
    dirs.push(dir)
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await writeFile(path.join(dir, name), text)
    }
    return dir
  }

  it('accepts code whose regular expressions are the spec\'s patterns', async () => {
    await expect(checkGeneratedCode(await folder({ 'zod.gen.ts': 'export const a = /^ok$/\n' }), new Set(['^ok$']))).resolves.toBeUndefined()
  })

  it('fails on a file that does not parse, or a regular expression the spec does not have', async () => {
    await expect(checkGeneratedCode(await folder({ 'sdk.gen.ts': 'export const a = (\n' }), new Set())).rejects.toThrow(/does not parse/)
    await expect(checkGeneratedCode(await folder({ 'zod.gen.ts': 'export const a = z.string().regex(/a\\/b/); globalThis.pwned = 1; /x/\n' }), new Set(['a']))).rejects.toThrow(/not a pattern of the spec/)
  })
})
