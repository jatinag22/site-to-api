import type { LoadedSession, StackFrame } from '../../model'
import { addMapping, GenMapping, setSourceContent, toEncodedMap } from '@jridgewell/gen-mapping'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeSessions, writeSession } from '../../../test/sessions'
import { createSourceResolver } from './index'

/**
 * Concatenates original files into one bundle, one bundle line per original line, with a mapping
 * at every word start so columns resolve exactly. `names` maps `file:line:column` to a name.
 */
function bundle(files: Array<{ source: string, content: string }>, names: Record<string, string> = {}): { code: string, map: unknown, lineOf: (source: string, line: number) => number } {
  const gen = new GenMapping({ file: 'main.js' })
  const out: string[] = []
  const starts = new Map<string, number>()
  for (const { source, content } of files) {
    setSourceContent(gen, source, content)
    starts.set(source, out.length + 1)
    content.split('\n').forEach((text, index) => {
      const generatedLine = out.length + 1
      out.push(text)
      for (const match of text.matchAll(/\b\w/g)) {
        const column = match.index
        const name = names[`${source}:${index + 1}:${column + 1}`]
        const mapping = {
          generated: { line: generatedLine, column },
          original: { line: index + 1, column },
          source,
        }
        if (name)
          addMapping(gen, { ...mapping, name })
        else
          addMapping(gen, mapping)
      }
    })
  }
  return {
    code: out.join('\n'),
    map: toEncodedMap(gen),
    lineOf: (source, line) => (starts.get(source) ?? 0) + line - 1,
  }
}

const productsTs = [
  'import axios from \'axios\'',
  '',
  'export async function loadProducts(category: string) {',
  `  const response = await axios.get(\`/api/products/\${category}\`)`,
  '  return response.data',
  '}',
].join('\n')

const xhrJs = [
  'export default function xhrAdapter(config) {',
  '  return new Promise(function dispatchXhrRequest(resolve) {',
  '    const request = new XMLHttpRequest()',
  '    request.send()',
  '  })',
  '}',
].join('\n')

const built = bundle([
  { source: 'webpack://shop/./node_modules/axios/lib/adapters/xhr.js', content: xhrJs },
  { source: 'webpack://shop/./src/api/products.ts', content: productsTs },
], { 'webpack://shop/./src/api/products.ts:4:32': 'get' })

let session: LoadedSession

function frame(url: string, line: number, column: number, functionName: string | null = null): StackFrame {
  return { url, line, column, functionName }
}

const MAIN = 'https://shop.test/static/js/main.js'
const VENDOR = 'https://shop.test/static/js/vendors.js'

beforeAll(async () => {
  session = await writeSession('s1', [
    {
      url: MAIN,
      file: 'scripts/shop.test/static/js/main.js',
      content: built.code,
      sourceMap: {
        url: `${MAIN}.map`,
        file: 'sourcemaps/shop.test/static/js/main.js.map',
        map: built.map,
        sources: {
          'sources/shop.test/src/api/products.ts': productsTs,
          'sources/shop.test/node_modules/axios/lib/adapters/xhr.js': xhrJs,
        },
      },
    },
    { url: VENDOR, file: 'scripts/shop.test/static/js/vendors.js', content: 'function n(){}' },
    { url: 'https://shop.test/static/js/app.js', file: 'scripts/shop.test/static/js/app.js', content: 'function a(){}' },
  ])
})

afterAll(removeSessions)

describe('createSourceResolver', () => {
  it('maps a bundle frame to the original file, line, column and name', async () => {
    const resolver = await createSourceResolver([session])
    const line = built.lineOf('webpack://shop/./src/api/products.ts', 4)
    const ref = resolver.resolve(frame(MAIN, line, 32, 'x'), 's1')
    expect(ref).toEqual({
      file: 'src/api/products.ts',
      line: 4,
      column: 32,
      functionName: 'get',
      original: true,
      excerpt: null,
    })
    expect(resolver.warnings).toEqual([])
  })

  it('keeps the frame function name when the map has no name for the position', async () => {
    const resolver = await createSourceResolver([session])
    const line = built.lineOf('webpack://shop/./src/api/products.ts', 5)
    expect(resolver.resolve(frame(MAIN, line, 3, 'loadProducts'), 's1')).toMatchObject({
      file: 'src/api/products.ts',
      line: 5,
      column: 3,
      functionName: 'loadProducts',
    })
  })

  it('ignores the URL fragment when matching scripts', async () => {
    const resolver = await createSourceResolver([session])
    const line = built.lineOf('webpack://shop/./src/api/products.ts', 5)
    expect(resolver.resolve(frame(`${MAIN}#x`, line, 3), 's1').original).toBe(true)
  })

  it('falls back to the bundle URL path without a sourcemap, for unknown scripts and other sessions', async () => {
    const resolver = await createSourceResolver([session])
    expect(resolver.resolve(frame(VENDOR, 1, 10, 'n'), 's1')).toEqual({
      file: '/static/js/vendors.js',
      line: 1,
      column: 10,
      functionName: 'n',
      original: false,
      excerpt: null,
    })
    expect(resolver.resolve(frame('https://cdn.test/lib.js?v=2', 3, 4), 's1')).toMatchObject({ file: '/lib.js', original: false })
    expect(resolver.resolve(frame(MAIN, 1, 1), 'other-session')).toMatchObject({ file: '/static/js/main.js', original: false })
  })

  it('warns about listed sourcemaps that are missing or malformed and resolves to the bundle', async () => {
    const broken = await writeSession('s2', [
      {
        url: MAIN,
        file: 'scripts/main.js',
        content: 'x',
        sourceMap: {
          url: `${MAIN}.map`,
          file: 'maps/main.js.map',
          map: '{not json',
          sources: {},
        },
      },
      {
        url: 'https://shop.test/b.js',
        file: 'scripts/b.js',
        content: 'x',
        sourceMap: {
          url: 'https://shop.test/b.js.map',
          file: 'maps/b.js.map',
          map: { version: 2 },
          sources: {},
        },
      },
    ])
    const missing = await writeSession('s3', [
      { url: MAIN, file: 'scripts/main.js', content: 'x' },
    ])
    missing.meta.scripts[0]!.sourceMap = { url: `${MAIN}.map`, file: 'maps/gone.map', sources: [] }
    const resolver = await createSourceResolver([broken, missing])
    expect(resolver.warnings).toHaveLength(3)
    expect(resolver.warnings[0]).toContain('not valid JSON')
    expect(resolver.warnings[1]).toContain('not a version 3 sourcemap')
    expect(resolver.warnings[2]).toContain('missing')
    expect(resolver.resolve(frame(MAIN, 1, 1), 's2').original).toBe(false)
  })

  it('refuses sourcemap paths that leave the session directory', async () => {
    const escaping = await writeSession('s4', [
      { url: MAIN, file: 'scripts/main.js', content: 'x' },
    ])
    escaping.meta.scripts[0]!.sourceMap = { url: `${MAIN}.map`, file: '../../etc/passwd', sources: [] }
    const resolver = await createSourceResolver([escaping])
    expect(resolver.warnings[0]).toContain('missing')
  })
})

describe('callSite', () => {
  const siteLine = built.lineOf('webpack://shop/./src/api/products.ts', 4)
  const libraryLine = built.lineOf('webpack://shop/./node_modules/axios/lib/adapters/xhr.js', 4)

  it('skips instrumentation, browser internals and node_modules frames', async () => {
    const resolver = await createSourceResolver([session])
    const stack = [
      frame('https://shop.test/site-to-api-instrument.js', 1, 200, 'window.fetch'),
      frame('', 0, 0, 'XMLHttpRequest.send'),
      frame('native', 0, 0),
      frame('chrome-extension://abc/content.js', 1, 1),
      frame(MAIN, libraryLine, 5, 'dispatchXhrRequest'),
      frame(MAIN, siteLine, 31, 'loadProducts'),
    ]
    expect(resolver.callSite(stack, 's1')).toMatchObject({ file: 'src/api/products.ts', line: 4, original: true })
  })

  it('skips known HTTP client functions and library bundles when there is no sourcemap', async () => {
    const resolver = await createSourceResolver([session])
    const stack = [
      frame('https://shop.test/static/js/app.js', 1, 10, 'dispatchXhrRequest'),
      frame('https://shop.test/static/js/app.js', 1, 20, 'Axios.request'),
      frame(VENDOR, 1, 5, 'e'),
      frame('https://code.jquery.test/jquery-3.7.1.min.js', 2, 100, 'send'),
      frame('https://shop.test/static/js/app.js', 1, 12, 'a'),
    ]
    expect(resolver.callSite(stack, 's1')).toEqual({
      file: '/static/js/app.js',
      line: 1,
      column: 12,
      functionName: 'a',
      original: false,
      excerpt: null,
    })
  })

  it('returns null when every frame is library or browser code', async () => {
    const resolver = await createSourceResolver([session])
    expect(resolver.callSite([
      frame('', 0, 0),
      frame(MAIN, libraryLine, 5),
    ], 's1')).toBeNull()
    expect(resolver.callSite([], 's1')).toBeNull()
  })
})
