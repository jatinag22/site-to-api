import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SiteToApiError } from '../errors'
import { defaultSessionId, normalizeSegments, safeJoin, sanitizeSegment, sanitizeSessionId, scriptFilePath, sourceFilePath, sourceMapFilePath } from './paths'

describe('sanitizeSegment', () => {
  it('keeps ordinary file names', () => {
    expect(sanitizeSegment('main.3f2a.js')).toBe('main.3f2a.js')
  })

  it('replaces unsafe characters and decodes percent escapes', () => {
    expect(sanitizeSegment('a b%20c<>:"|?*.js')).toBe('a_b_c_______.js')
  })

  it('turns names made only of dots into underscores, except . and ..', () => {
    expect(sanitizeSegment('...')).toBe('___')
    expect(sanitizeSegment('..')).toBe('..')
  })

  it('caps long names, keeping the extension and staying unique', () => {
    const a = sanitizeSegment(`${'a'.repeat(300)}.js`)
    const b = sanitizeSegment(`${'a'.repeat(299)}b.js`)
    expect(a.length).toBeLessThanOrEqual(120)
    expect(a.endsWith('.js')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('decodes an encoded slash into a safe character instead of a separator', () => {
    expect(sanitizeSegment('..%2F..%2Fetc')).toBe('.._.._etc')
  })
})

describe('normalizeSegments', () => {
  it('resolves . and .. inside the path', () => {
    expect(normalizeSegments('a/./b/../c.js')).toEqual(['a', 'c.js'])
  })

  it('never climbs above the root', () => {
    expect(normalizeSegments('../../etc/passwd')).toEqual(['__', '__', 'etc', 'passwd'])
    expect(normalizeSegments('/a/../../b')).toEqual(['__', 'b'])
  })

  it('treats backslashes as separators', () => {
    expect(normalizeSegments('..\\..\\windows\\system32')).toEqual(['__', '__', 'windows', 'system32'])
  })
})

describe('scriptFilePath', () => {
  it('maps host and path', () => {
    expect(scriptFilePath('https://cdn.example.com/static/js/app.js')).toBe('scripts/cdn.example.com/static/js/app.js')
  })

  it('keeps the port in the host directory', () => {
    expect(scriptFilePath('http://127.0.0.1:8080/app.js')).toBe('scripts/127.0.0.1_8080/app.js')
  })

  it('hashes the query string into the name', () => {
    const a = scriptFilePath('https://example.com/app.js?v=1')
    const b = scriptFilePath('https://example.com/app.js?v=2')
    expect(a).toMatch(/^scripts\/example\.com\/app~[0-9a-f]{8}\.js$/)
    expect(a).not.toBe(b)
  })

  it('names directory URLs and extensionless scripts so they cannot collide', () => {
    expect(scriptFilePath('https://example.com/')).toBe('scripts/example.com/index.js')
    expect(scriptFilePath('https://example.com/loader')).toBe('scripts/example.com/loader.js')
    expect(scriptFilePath('https://example.com/loader/x.js')).toBe('scripts/example.com/loader/x.js')
  })

  it('cannot escape through encoded traversal', () => {
    const file = scriptFilePath('https://example.com/a/%2e%2e/%2e%2e/%2e%2e/evil.js')
    expect(file.startsWith('scripts/example.com/')).toBe(true)
    expect(file.split('/')).not.toContain('..')
  })
})

describe('sourceMapFilePath', () => {
  it('mirrors the script path under sourcemaps/', () => {
    expect(sourceMapFilePath('scripts/example.com/app.js')).toBe('sourcemaps/example.com/app.js.map')
  })
})

describe('sourceFilePath', () => {
  it('strips bundler protocol prefixes', () => {
    expect(sourceFilePath('example.com', 'webpack:///./src/index.ts', undefined)).toBe('sources/example.com/src/index.ts')
    expect(sourceFilePath('example.com', 'webpack://my-app/./src/a.tsx', undefined)).toBe('sources/example.com/my-app/src/a.tsx')
    expect(sourceFilePath('example.com', 'vite://src/main.ts', undefined)).toBe('sources/example.com/src/main.ts')
    expect(sourceFilePath('example.com', 'file:///home/dev/app/x.js', undefined)).toBe('sources/example.com/home/dev/app/x.js')
  })

  it('blocks traversal', () => {
    expect(sourceFilePath('example.com', 'webpack:///../../../etc/passwd', undefined)).toBe('sources/example.com/__/__/__/etc/passwd')
  })

  it('applies sourceRoot to relative sources only', () => {
    expect(sourceFilePath('h', 'a.ts', '/src/')).toBe('sources/h/src/a.ts')
    expect(sourceFilePath('h', 'webpack:///b.ts', '/src/')).toBe('sources/h/b.ts')
  })

  it('hashes query strings and names empty sources', () => {
    expect(sourceFilePath('h', 'webpack:///./App.vue?3f2a', undefined)).toMatch(/^sources\/h\/App~[0-9a-f]{8}\.vue$/)
    expect(sourceFilePath('h', 'webpack://', undefined)).toBe('sources/h/unnamed')
  })
})

describe('safeJoin', () => {
  it('joins paths inside the root', () => {
    expect(safeJoin('/tmp/s', 'scripts/a.js')).toBe(path.resolve('/tmp/s/scripts/a.js'))
  })

  it('refuses paths outside the root', () => {
    expect(() => safeJoin('/tmp/s', '../x')).toThrow(SiteToApiError)
    expect(() => safeJoin('/tmp/s', '/etc/passwd')).toThrow(SiteToApiError)
    expect(() => safeJoin('/tmp/s', '../s2/x')).toThrow(SiteToApiError)
  })
})

describe('session ids', () => {
  const now = new Date(Date.UTC(2026, 9, 28, 7, 5, 9))

  it('builds the default from host and UTC time', () => {
    expect(defaultSessionId('https://shop.example.com:8443/cart', now)).toBe('shop.example.com-20261028-070509')
    expect(defaultSessionId(null, now)).toBe('blank-20261028-070509')
    expect(defaultSessionId('about:blank', now)).toBe('blank-20261028-070509')
  })

  it('sanitises given ids', () => {
    expect(sanitizeSessionId('../my session/1')).toBe('my-session-1')
    expect(() => sanitizeSessionId('///')).toThrow(SiteToApiError)
  })
})
