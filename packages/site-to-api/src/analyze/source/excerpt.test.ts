import type { LoadedSession, SourceRef } from '../../model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeSessions, writeSession } from '../../../test/sessions'
import { buildExcerpt } from './excerpt'

const cartTs = [
  'import { sign } from \'./sign\'', // 1
  '', // 2
  'export async function checkout(cart: { id: string }) {', // 3
  '  const signature = sign(cart.id)', // 4
  `  return fetch(\`/api/checkout/\${cart.id}\`, {`, // 5
  '    method: \'POST\',', // 6
  '    headers: { \'x-signature\': signature },', // 7
  '  })', // 8
  '}', // 9
  '', // 10
  'export const VERSION = \'1\'', // 11
].join('\n')

const longFunction = [
  'export function big() {',
  ...Array.from({ length: 200 }, (_, i) => `  step${i}()`),
  '}',
].join('\n')

const statements = Array.from({ length: 300 }, (_, i) => `var v${i}=compute(${i});`).join('')
const minified = `!function(){${statements}function send(t){return fetch("/api/orders/"+t,{method:"POST"})}${statements}}();`

let session: LoadedSession

function ref(init: Partial<SourceRef>): SourceRef {
  return {
    file: 'src/cart.ts',
    line: 5,
    column: 10,
    functionName: 'checkout',
    original: true,
    excerpt: null,
    ...init,
  }
}

beforeAll(async () => {
  session = await writeSession('2026-01-01-abc', [
    {
      url: 'https://shop.test/static/main.js',
      file: 'scripts/shop.test/static/main.js',
      content: '',
      sourceMap: {
        url: 'https://shop.test/static/main.js.map',
        file: 'sourcemaps/shop.test/static/main.js.map',
        map: {},
        sources: {
          'sources/shop.test/src/cart.ts': cartTs,
          'sources/shop.test/src/big.ts': longFunction,
        },
      },
    },
    { url: 'https://shop.test/static/app.min.js?v=3', file: 'scripts/shop.test/static/app.min.js', content: minified },
    {
      url: 'https://shop.test/static/plain.js',
      file: 'scripts/shop.test/static/plain.js',
      content: Array.from({ length: 100 }, (_, i) => `line${i + 1}()`).join('\n'),
    },
  ])
})

afterAll(removeSessions)

describe('buildExcerpt', () => {
  it('returns the whole enclosing function of an original file with a header', async () => {
    const excerpt = await buildExcerpt(ref({}), [session], '2026-01-01-abc')
    expect(excerpt?.path).toBe('src/cart.L3-9.ts')
    expect(excerpt?.content).toBe([
      '// site-to-api excerpt of src/cart.ts:5:10 (function checkout)',
      '// Lines 3-9 (the enclosing function) of the original source, captured in session 2026-01-01-abc.',
      ...cartTs.split('\n').slice(2, 9),
      '',
    ].join('\n'))
  })

  it('falls back to 40 lines either side for long functions and top-level code', async () => {
    const long = await buildExcerpt(ref({ file: 'src/big.ts', line: 100, column: 3 }), [session], '2026-01-01-abc')
    expect(long?.path).toBe('src/big.L60-140.ts')
    expect(long?.content.split('\n')[2]).toBe('  step58()')
    const topLevel = await buildExcerpt(ref({ line: 11, column: 1 }), [session], '2026-01-01-abc')
    expect(topLevel?.path).toBe('src/cart.L1-11.ts')
  })

  it('cuts a minified bundle at statement boundaries around the column', async () => {
    const column = minified.indexOf('fetch(') + 1
    const excerpt = await buildExcerpt(ref({
      file: '/static/app.min.js',
      line: 1,
      column,
      functionName: 'send',
      original: false,
    }), [session], '2026-01-01-abc')
    expect(excerpt?.path).toBe(`bundles/shop.test/static/app.min.L1C${column}.js`)
    const lines = excerpt?.content.split('\n') ?? []
    expect(lines[0]).toBe(`// site-to-api excerpt of /static/app.min.js:1:${column} (function send) in https://shop.test/static/app.min.js?v=3`)
    expect(lines).toContain('function send(t){')
    expect(lines).toContain(`  return /* <-- 1:${column} */ fetch("/api/orders/"+t,{method:"POST"})}`)
    const body = lines.slice(2)
    expect(body.every(line => line.length < 200)).toBe(true)
    // Every line of the body starts at a statement, never in the middle of one.
    expect(body.filter(line => line.trim() !== '').every(line => /^\s*(?:var v\d+=compute\(\d+\);|function send|return|\})/.test(line))).toBe(true)
    expect(excerpt?.content.length).toBeLessThan(3700)
  })

  it('uses a line window for bundles that are not minified', async () => {
    const excerpt = await buildExcerpt(ref({
      file: '/static/plain.js',
      line: 50,
      column: 1,
      functionName: null,
      original: false,
    }), [session], '2026-01-01-abc')
    expect(excerpt?.path).toBe('bundles/shop.test/static/plain.L50C1.js')
    const lines = excerpt?.content.split('\n') ?? []
    expect(lines[2]).toBe('line10()')
    expect(lines.at(-2)).toBe('line90()')
  })

  it('makes paths safe and returns null for unknown files or sessions', async () => {
    expect(await buildExcerpt(ref({ file: '../../etc/passwd' }), [session], '2026-01-01-abc')).toBeNull()
    expect(await buildExcerpt(ref({}), [session], 'other')).toBeNull()
    expect(await buildExcerpt(ref({ file: '/nope.js', original: false }), [session], '2026-01-01-abc')).toBeNull()
    const odd = await writeSession('s2', [
      {
        url: 'https://shop.test/a.js',
        file: 'scripts/a.js',
        content: '',
        sourceMap: {
          url: 'https://shop.test/a.js.map',
          file: 'maps/a.map',
          map: {},
          sources: { 'sources/shop.test/src/we ird/<x>.js': 'function f(){\n  return 1\n}' },
        },
      },
    ])
    const excerpt = await buildExcerpt(ref({ file: 'src/we ird/<x>.js', line: 2, column: 3 }), [odd], 's2')
    expect(excerpt?.path).toBe('src/we_ird/_x_.L1-3.js')
  })
})
