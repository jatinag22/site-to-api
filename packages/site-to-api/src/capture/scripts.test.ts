import type { RefetchedScript } from './scripts'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeDataUri, isSkippedScriptHost, parseSourceMap, refetchRefusal, scriptBody, scriptFailureWarning, sourceMapCandidates } from './scripts'
import { WarningLog } from './warnings'

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

describe('scriptBody', () => {
  const cached = async (): Promise<Buffer> => {
    throw new Error('Response body is unavailable for redirect responses')
  }
  function again(status: number, body: string, length: number | null = null): { fetched: () => Promise<RefetchedScript>, disposed: () => boolean } {
    let disposed = false
    return {
      fetched: async () => ({
        status,
        length,
        body: async () => Buffer.from(body),
        dispose: async () => {
          disposed = true
        },
      }),
      disposed: () => disposed,
    }
  }

  it('uses the response body when the browser still has it, without fetching', async () => {
    let fetched = false
    const body = await scriptBody(async () => Buffer.from('a()'), async () => {
      fetched = true
      throw new Error('no')
    })
    expect(body.toString()).toBe('a()')
    expect(fetched).toBe(false)
  })

  it('fetches a cached or evicted script once more and disposes the response', async () => {
    const refetch = again(200, 'b()')
    expect((await scriptBody(cached, refetch.fetched)).toString()).toBe('b()')
    expect(refetch.disposed()).toBe(true)
  })

  it('fails with both reasons on an error status, a failed fetch or an oversized body', async () => {
    await expect(scriptBody(cached, again(404, '').fetched)).rejects.toThrow('Response body is unavailable for redirect responses; fetching it again returned HTTP 404')
    await expect(scriptBody(cached, async () => {
      throw new Error('timeout')
    })).rejects.toThrow('; fetching it again failed: timeout')
    const big = again(200, 'x', 50)
    await expect(scriptBody(cached, big.fetched, 10)).rejects.toThrow('50 bytes is over the 10-byte limit')
    expect(big.disposed()).toBe(true)
    await expect(scriptBody(cached, again(200, 'x'.repeat(11)).fetched, 10)).rejects.toThrow('11 bytes is over the 10-byte limit')
  })
})

describe('scriptFailureWarning', () => {
  it('says one failure in full and many in one line with the count and the first URL', () => {
    const one = new WarningLog()
    const first = scriptFailureWarning('https://a.test/1.js', 'No resource with given identifier found')
    one.addGrouped('script-body', 'https://a.test/1.js', first.single, first.summary)
    expect(one.list()).toEqual(['Could not save script https://a.test/1.js: No resource with given identifier found'])
    const many = new WarningLog()
    for (let index = 1; index <= 150; index++) {
      const warning = scriptFailureWarning(`https://a.test/${index}.js`, 'Response body is unavailable')
      many.addGrouped('script-body', `https://a.test/${index}.js`, warning.single, warning.summary)
    }
    expect(many.list()).toEqual(['Could not save 150 scripts (first: https://a.test/1.js: Response body is unavailable); source analysis has no code for them.'])
  })
})

describe('refetchRefusal', () => {
  const addresses: Record<string, string[]> = {
    'www.shop.test': ['93.184.216.34'],
    'static.shop.test': ['93.184.216.35'],
    'cdn.other.test': ['93.184.216.36'],
    'internal.shop.test': ['10.0.0.5'],
  }
  const lookup = async (host: string): Promise<string[]> => addresses[host] ?? []

  it('allows a script of the page\'s own site on a public address', async () => {
    expect(await refetchRefusal(new URL('https://static.shop.test/app.js'), 'https://www.shop.test/', null, lookup)).toBeNull()
  })

  it('refuses a script of another site, which would get cookies the browser withheld', async () => {
    expect(await refetchRefusal(new URL('https://cdn.other.test/app.js'), 'https://www.shop.test/', null, lookup))
      .toContain('not on the page\'s own site (shop.test)')
  })

  it('refuses worker scripts, whose page is unknown', async () => {
    expect(await refetchRefusal(new URL('https://static.shop.test/sw.js'), null, null, lookup)).toBe('the page that loaded it is unknown')
  })

  it('refuses a public page\'s script on a private address, like a sourcemap', async () => {
    expect(await refetchRefusal(new URL('https://internal.shop.test/app.js'), 'https://www.shop.test/', null, lookup)).toMatch(/10\.0\.0\.5/)
  })
})
