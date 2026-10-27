import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeDataUri, isSkippedScriptHost, parseSourceMap, sourceMapCandidates } from './scripts'

describe('sourceMapCandidates', () => {
  const script = 'https://example.com/static/app.js?v=3'

  it('tries the header, then the comment, then <url>.map', () => {
    const candidates = sourceMapCandidates(script, { sourcemap: '/maps/app.map' }, 'x()\n//# sourceMappingURL=app.js.map?v=3')
    expect(candidates).toEqual([
      { kind: 'url', url: 'https://example.com/maps/app.map', guess: false },
      { kind: 'url', url: 'https://example.com/static/app.js.map?v=3', guess: false },
      { kind: 'url', url: 'https://example.com/static/app.js.map', guess: true },
    ])
  })

  it('reads X-SourceMap and old //@ comments and uses only the last comment', () => {
    const body = '//# sourceMappingURL=first.map\nx()\n//@ sourceMappingURL=second.map'
    expect(sourceMapCandidates(script, { 'x-sourcemap': 'h.map' }, body).map(c => c.kind === 'url'
      ? c.url
      : c.text)).toEqual([
      'https://example.com/static/h.map',
      'https://example.com/static/second.map',
      'https://example.com/static/app.js.map',
    ])
  })

  it('decodes inline data: maps', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['a.ts'],
      mappings: '',
    })
    const body = `x()\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}`
    expect(sourceMapCandidates(script, {}, body)[0]).toEqual({ kind: 'inline', text: map })
  })

  it('handles block comments and removes duplicate URLs', () => {
    const body = 'x()\n/*# sourceMappingURL=app.js.map */'
    expect(sourceMapCandidates('https://example.com/app.js', {}, body)).toEqual([
      { kind: 'url', url: 'https://example.com/app.js.map', guess: false },
    ])
  })

  it('ignores non-HTTP references', () => {
    expect(sourceMapCandidates('https://example.com/app.js', {}, '//# sourceMappingURL=file:///etc/passwd')).toEqual([
      { kind: 'url', url: 'https://example.com/app.js.map', guess: true },
    ])
  })
})

describe('decodeDataUri', () => {
  it('decodes base64 and percent-encoded data', () => {
    expect(decodeDataUri(`data:application/json;base64,${Buffer.from('{"a":1}').toString('base64')}`)).toBe('{"a":1}')
    expect(decodeDataUri('data:application/json,%7B%22a%22%3A1%7D')).toBe('{"a":1}')
  })

  it('returns null for malformed URIs', () => {
    expect(decodeDataUri('data:application/json')).toBeNull()
    expect(decodeDataUri('data:,%E0%A4%A')).toBeNull()
  })
})

describe('parseSourceMap', () => {
  it('accepts maps with version and sources, including the XSSI prefix', () => {
    expect(parseSourceMap(`)]}'\n{"version":3,"sources":["a.ts"],"sourcesContent":["x"],"mappings":""}`)?.sources).toEqual(['a.ts'])
  })

  it('rejects other JSON and HTML error pages', () => {
    expect(parseSourceMap('{"version":3,"sections":[]}')).toBeNull()
    expect(parseSourceMap('{"sources":[]}')).toBeNull()
    expect(parseSourceMap('<html>Not found</html>')).toBeNull()
  })
})

describe('isSkippedScriptHost', () => {
  it('matches listed hosts and their subdomains only', () => {
    expect(isSkippedScriptHost('www.googletagmanager.com')).toBe(true)
    expect(isSkippedScriptHost('stats.g.doubleclick.net')).toBe(true)
    expect(isSkippedScriptHost('notdoubleclick.net')).toBe(false)
    expect(isSkippedScriptHost('example.com')).toBe(false)
  })
})
