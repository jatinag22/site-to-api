import type { LoadedSession, SourceRef } from '../../model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeSessions, writeSession } from '../../../test/sessions'
import { buildExcerpt } from './index'

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
/** A small minified script: one line of a few hundred characters, well under the long-line limit. */
const sensor = '"use strict";(()=>{function e(){return["2","toy-sensor",location.pathname].join(";")}async function t(){let o=await fetch("/shield/collect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sensor_data:e()}),credentials:"same-origin"});if(await o.text(),!o.ok)throw new Error("collector failed")}window.pmShield={ready:t()};})();'
/** Packed code that does not parse (a truncated bundle): split by `;`, `{` and `}` instead. */
const broken = `var a=1;var b={x:"a;b{c}"};function f(){g();h();/* ; { */if(a){b()}}; var c=\`t;{a}\`;f(;`

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
    { url: 'https://shop.test/shield/sensor.js', file: 'scripts/shop.test/shield/sensor.js', content: sensor },
    {
      url: 'https://shop.test/static/broken.js',
      file: 'scripts/shop.test/static/broken.js',
      content: [broken, broken, broken].join(' '),
    },
    {
      url: 'https://shop.test/static/plain.js',
      file: 'scripts/shop.test/static/plain.js',
      content: Array.from({ length: 100 }, (_, i) => `line${i + 1}()`).join('\n'),
    },
  ])
})

afterAll(removeSessions)

/** The code inside an excerpt's fence, with a trailing newline, as the original lines were. */
function code(excerpt: { content: string } | null | undefined): string {
  const lines = (excerpt?.content ?? '').split('\n')
  const open = lines.findIndex(line => line.startsWith('```'))
  const close = lines.findLastIndex(line => line.startsWith('```'))
  return `${lines.slice(open + 1, close).join('\n')}\n`
}

/** The opening fence line. */
function excerpt0(excerpt: { content: string } | null | undefined): string {
  return (excerpt?.content ?? '').split('\n').find(line => line.startsWith('```')) ?? ''
}

/** The heading and the description line above the fence. */
function header(excerpt: { content: string } | null | undefined): string[] {
  const lines = (excerpt?.content ?? '').split('\n')
  return [lines[0] ?? '', lines[2] ?? '']
}

describe('buildExcerpt', () => {
  it('returns the whole enclosing function of an original file with a header', async () => {
    const excerpt = await buildExcerpt(ref({}), [session], '2026-01-01-abc')
    expect(excerpt?.path).toBe('src/cart.L3-9.ts.md')
    expect(excerpt?.content).toBe([
      '# Excerpt of `src/cart.ts:5:10` (function `checkout`)',
      '',
      'Lines 3-9 (the enclosing function) of the original source, captured in session `2026-01-01-abc`.',
      '',
      '```ts',
      ...cartTs.split('\n').slice(2, 9),
      '```',
      '',
    ].join('\n'))
  })

  it('falls back to 40 lines either side for long functions and top-level code', async () => {
    const long = await buildExcerpt(ref({ file: 'src/big.ts', line: 100, column: 3 }), [session], '2026-01-01-abc')
    expect(long?.path).toBe('src/big.L60-140.ts.md')
    expect(code(long).split('\n')[0]).toBe('  step58()')
    const topLevel = await buildExcerpt(ref({ line: 11, column: 1 }), [session], '2026-01-01-abc')
    expect(topLevel?.path).toBe('src/cart.L1-11.ts.md')
  })

  it('never writes a script URL\'s query or token path segments into the header', async () => {
    const secret = 'Zq8Wm3Np5Rt7Vx9Bc2DfKp7xQ2mZ9vLr'
    const tokenSession = await writeSession('s-tok', [
      { url: `https://shop.test/static/${secret}/ips.js?KP_UIDz=${secret}&v=1`, file: 'scripts/shop.test/ips.js', content: 'a()\nb()\nc()' },
    ])
    const excerpt = await buildExcerpt(ref({
      file: '/static/{token}/ips.js',
      line: 2,
      column: 1,
      original: false,
      functionName: 'f',
    }), [tokenSession], 's-tok')
    expect(header(excerpt)[0]).toBe('# Excerpt of `/static/{token}/ips.js:2:1` (function `f`) in `https://shop.test/static/{token}/ips.js?<query omitted>`')
    expect(excerpt?.content).not.toContain(secret)
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
    expect(excerpt?.path).toBe(`bundles/shop.test/static/app.min.L1C${column}.js.md`)
    const lines = code(excerpt).split('\n') ?? []
    expect(header(excerpt)[0]).toBe(`# Excerpt of \`/static/app.min.js:1:${column}\` (function \`send\`) in \`https://shop.test/static/app.min.js?<query omitted>\``)
    expect(excerpt?.content).toContain('\n```js\n')
    expect(lines).toContain('function send(t){')
    expect(lines).toContain(`  return /* <-- 1:${column} */ fetch("/api/orders/"+t,{method:"POST"})`)
    // The closing brace of `send` goes back to the function's own depth.
    expect(lines[lines.indexOf('function send(t){') + 2]).toBe('}')
    const body = lines
    expect(body.every(line => line.length < 200)).toBe(true)
    // Every line of the body starts at a statement, never in the middle of one.
    expect(body.filter(line => line.trim() !== '').every(line => /^\s*(?:var v\d+=compute\(\d+\);|function send|return|\})/.test(line))).toBe(true)
    expect(code(excerpt).length).toBeLessThan(3700)
  })

  it('breaks a short minified script at statements and closing braces, indented by nesting', async () => {
    const column = sensor.indexOf('fetch(') + 1
    const excerpt = await buildExcerpt(ref({
      file: '/shield/sensor.js',
      line: 1,
      column,
      functionName: 't',
      original: false,
    }), [session], '2026-01-01-abc')
    const body = code(excerpt).split('\n').slice(0, -1) ?? []
    expect(body).toEqual([
      '"use strict";',
      '(()=>{',
      '  function e(){',
      '    return["2","toy-sensor",location.pathname].join(";")',
      '  }',
      '  async function t(){',
      `    let o=await /* <-- 1:${column} */ fetch("/shield/collect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sensor_data:e()}),credentials:"same-origin"});`,
      '    if(await o.text(),!o.ok)',
      '      throw new Error("collector failed")',
      '  }',
      '  window.pmShield={ready:t()};',
      '})();',
    ])
  })

  it('splits code that does not parse at `;`, `{` and `}` outside strings and comments', async () => {
    const excerpt = await buildExcerpt(ref({
      file: '/static/broken.js',
      line: 1,
      column: 9,
      functionName: null,
      original: false,
    }), [session], '2026-01-01-abc')
    const body = code(excerpt).split('\n').slice(0, -1) ?? []
    expect(body.slice(0, 9)).toEqual([
      'var a=1;',
      '/* <-- 1:9 */ var b={',
      '  x:"a;b{c}"',
      '};',
      'function f(){',
      '  g();',
      '  h();',
      '  /* ; { */if(a){',
      '    b()',
    ])
    expect(body).toContain('var c=`t;{a}`;')
  })

  it('uses a line window for bundles that are not minified', async () => {
    const excerpt = await buildExcerpt(ref({
      file: '/static/plain.js',
      line: 50,
      column: 1,
      functionName: null,
      original: false,
    }), [session], '2026-01-01-abc')
    expect(excerpt?.path).toBe('bundles/shop.test/static/plain.L50C1.js.md')
    const lines = code(excerpt).split('\n') ?? []
    expect(lines[0]).toBe('line10()')
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
    expect(excerpt?.path).toBe('src/we_ird/_x_.L1-3.js.md')
  })

  it('keeps names and URLs from the site inside one-line code spans', async () => {
    const hostile = await writeSession('s3', [
      {
        url: 'https://shop.test/w.js',
        file: 'scripts/w.js',
        content: '',
        sourceMap: {
          url: 'https://shop.test/w.js.map',
          file: 'maps/w.map',
          map: {},
          sources: {
            'sources/shop.test/src/Widget-->.vue': '<script>\nfunction f(){\n  return 1\n}\n</script>',
            'sources/shop.test/src/w.ts': 'function f(){\n  return 1\n}',
          },
        },
      },
      { url: 'https://shop.test/b.js?x=\n*/ evil() /*\u2028', file: 'scripts/b.js', content: 'a()\nb()\nc()' },
    ])
    const name = 'f\n--> <script>evil()</script> <!--\r\n*/ evil() /*\u2028x'
    const vue = await buildExcerpt(ref({
      file: 'src/Widget-->.vue',
      line: 3,
      column: 3,
      functionName: name,
    }), [hostile], 's3')
    const ts = await buildExcerpt(ref({
      file: 'src/w.ts',
      line: 2,
      column: 3,
      functionName: name,
    }), [hostile], 's3')
    const bundle = await buildExcerpt(ref({
      file: '/b.js',
      line: 2,
      column: 1,
      functionName: name,
      original: false,
    }), [hostile], 's3')
    for (const excerpt of [vue, ts, bundle]) {
      // A heading and one description line, each a single line whose site text sits in code
      // spans, then the fenced code.
      for (const line of header(excerpt))
        expect(line).not.toMatch(/[\r\u2028\u2029]/)
      expect(excerpt?.content.split('\n')[1]).toBe('')
      expect(excerpt?.content.split('\n')[4]).toMatch(/^```/)
    }
    expect(header(vue)[0]).toBe('# Excerpt of `src/Widget-->.vue:3:3` (function `f --> <script>evil()</script> <!-- */ evil() /* x`)')
    expect(excerpt0(vue)).toBe('```vue')
    expect(code(vue).split('\n')[0]).toBe('<script>')
    expect(code(ts).split('\n')[0]).toBe('function f(){')
    expect(header(bundle)[0]).toBe('# Excerpt of `/b.js:2:1` (function `f --> <script>evil()</script> <!-- */ evil() /* x`) in `https://shop.test/b.js?<query omitted>`')
  })

  it('makes the fence longer than any backtick run in the code', async () => {
    const ticks = await writeSession('s4', [
      { url: 'https://shop.test/t.js', file: 'scripts/t.js', content: 'a()\nconst s = `x`\n/* ```` */\nb()' },
    ])
    const excerpt = await buildExcerpt(ref({
      file: '/t.js',
      line: 2,
      column: 1,
      functionName: null,
      original: false,
    }), [ticks], 's4')
    const lines = excerpt?.content.split('\n') ?? []
    expect(lines[4]).toBe('`````js')
    expect(lines.at(-2)).toBe('`````')
  })
})

describe('buildExcerpt: never compiled', () => {
  it('writes Markdown, so a fragment with a syntax error cannot break a type check', async () => {
    const excerpt = await buildExcerpt(ref({}), [session], '2026-01-01-abc')
    expect(excerpt?.path).toMatch(/\.md$/)
    expect(excerpt?.content).not.toContain('@ts-nocheck')
  })
})
