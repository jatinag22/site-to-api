import { describe, expect, it } from 'vitest'
import { anyItemPointer, formatLocation, keySafeLocation, keySafePointer, outputName, positionSkeleton, repeatedSelector, safePageUrl, slugify, uniqueName } from './locations'

describe('formatLocation', () => {
  it.each([
    [
      { in: 'path', index: 2 } as const,
      'path.2',
    ],
    [
      { in: 'query', name: 'symbol' } as const,
      'query.symbol',
    ],
    [
      { in: 'header', name: 'x-csrf-token' } as const,
      'header.x-csrf-token',
    ],
    [
      { in: 'cookie', name: 'session' } as const,
      'cookie.session',
    ],
    [
      { in: 'body', pointer: '/user/id' } as const,
      'body./user/id',
    ],
    [
      { in: 'form', name: 'user' } as const,
      'form.user',
    ],
    [
      { in: 'set-cookie', name: 'session' } as const,
      'set-cookie.session',
    ],
    [
      { in: 'response-header', name: 'x-token' } as const,
      'header.x-token',
    ],
    [
      {
        in: 'html',
        selector: 'meta[name="csrf"]',
        attr: 'content',
        pattern: null,
      } as const,
      'html.meta[name="csrf"]@content',
    ],
    [
      {
        in: 'html',
        selector: 'script',
        attr: null,
        pattern: 'key="(.+?)"',
      } as const,
      'html.script /key="(.+?)"/',
    ],
  ])('formats %j as %s', (location, expected) => {
    expect(formatLocation(location)).toBe(expected)
  })
})

describe('outputName', () => {
  it('uses the last named pointer segment, the cookie or header name, or the HTML name', () => {
    expect(outputName({ in: 'body', pointer: '/items/0/id' })).toBe('id')
    expect(outputName({ in: 'body', pointer: '/0' })).toBe('body')
    expect(outputName({ in: 'body', pointer: '/items/*/id' })).toBe('id')
    expect(outputName({ in: 'body', pointer: '/tags/*' })).toBe('tags')
    expect(outputName({ in: 'body', pointer: '/a~1b' })).toBe('a/b')
    expect(outputName({ in: 'set-cookie', name: 'sid' })).toBe('cookie.sid')
    expect(outputName({ in: 'response-header', name: 'x-token' })).toBe('header.x-token')
    expect(outputName({
      in: 'html',
      selector: '#pubkey',
      attr: 'value',
      pattern: null,
    })).toBe('pubkey')
    expect(outputName({
      in: 'html',
      selector: '',
      attr: null,
      pattern: null,
    })).toBe('html')
  })
})

describe('slugify and uniqueName', () => {
  it('makes readable, unique ids', () => {
    expect(slugify('  Sign in → Café!  ', 'flow')).toBe('sign-in-cafe')
    expect(slugify('→', 'flow')).toBe('flow')
    const taken = new Set<string>()
    expect([
      uniqueName('go', taken),
      uniqueName('go', taken),
      uniqueName('go', taken),
    ]).toEqual(['go', 'go-2', 'go-3'])
  })
})

describe('safePageUrl', () => {
  it('drops query and fragment', () => {
    expect(safePageUrl('https://www.example.test/reset?token=abc#x')).toBe('https://www.example.test/reset')
    expect(safePageUrl('not a url?token=abc')).toBe('not a url')
    expect(safePageUrl(null)).toBe('')
  })

  it('replaces token path segments with {token}', () => {
    expect(safePageUrl('https://www.example.test/reset/secrettokenvalue_abcdefghijklmnop?x=1')).toBe('https://www.example.test/reset/{token}')
    expect(safePageUrl('https://www.example.test/files/aB3dE5gH7jK9mN1pQ2xY/view')).toBe('https://www.example.test/files/{token}/view')
    expect(safePageUrl('https://www.example.test/promo/summer-sale-2026')).toBe('https://www.example.test/promo/summer-sale-2026')
  })
})

describe('anyItemPointer', () => {
  it('replaces array indexes with `*` along the pointer', () => {
    expect(anyItemPointer([
      { slug: 'a' },
      { slug: 'b' },
    ], '/1/slug')).toBe('/*/slug')
    expect(anyItemPointer({
      items: [
        {
          tags: ['x', 'y'],
        },
      ],
    }, '/items/0/tags/1')).toBe('/items/*/tags/*')
  })

  it('keeps numeric object keys, escaped keys and paths the body does not have', () => {
    expect(anyItemPointer({
      2024: { total: 1 },
    }, '/2024/total')).toBe('/2024/total')
    expect(anyItemPointer({
      'a/b': [
        { id: 1 },
      ],
    }, '/a~1b/0/id')).toBe('/a~1b/*/id')
    expect(anyItemPointer(undefined, '/0/id')).toBe('/0/id')
    expect(anyItemPointer([], '')).toBe('')
  })
})

describe('repeatedSelector', () => {
  it('drops the positions that differ and keeps the shared ones', () => {
    expect(repeatedSelector([
      '#store-list > li:nth-of-type(1) > a:nth-of-type(1)',
      '#store-list > li:nth-of-type(2) > a:nth-of-type(1)',
    ])).toBe('#store-list > li > a:nth-of-type(1)')
    expect(repeatedSelector([
      'table > tr:nth-of-type(1) > td:nth-of-type(2)',
      'table > tr:nth-of-type(3) > td:nth-of-type(4)',
    ])).toBe('table > tr > td')
  })

  it('refuses selectors that differ by more than position', () => {
    expect(repeatedSelector(['#a > li:nth-of-type(1)', '#b > li:nth-of-type(2)'])).toBeNull()
    expect(repeatedSelector([])).toBeNull()
  })

  it('gives a skeleton shared by selectors that differ only by position', () => {
    expect(positionSkeleton('ul > li:nth-of-type(3) > a')).toBe('ul > li:nth-of-type(#) > a')
  })
})

describe('keySafePointer / keySafeLocation', () => {
  const isSecretKey = (key: string): boolean => key === 'a/b@x.test' || key === 'tok'

  it('replaces secret segments, unescaped first, and keeps the rest', () => {
    expect(keySafePointer('/users/a~1b@x.test/name', isSecretKey)).toBe('/users/{key}/name')
    expect(keySafePointer('/items/*/tok', isSecretKey)).toBe('/items/*/{key}')
    expect(keySafePointer('/items/0/id', isSecretKey)).toBe('/items/0/id')
    expect(keySafePointer('', isSecretKey)).toBe('')
  })

  it('replaces secret form field names, and leaves other locations alone', () => {
    expect(keySafeLocation({ in: 'form', name: 'tok' }, isSecretKey)).toEqual({ in: 'form', name: '{key}' })
    expect(keySafeLocation({ in: 'form', name: 'q' }, isSecretKey)).toEqual({ in: 'form', name: 'q' })
    expect(keySafeLocation({ in: 'body', pointer: '/tok' }, isSecretKey)).toEqual({ in: 'body', pointer: '/{key}' })
    expect(keySafeLocation({ in: 'query', name: 'tok' }, isSecretKey)).toEqual({ in: 'query', name: 'tok' })
  })
})

describe('jSON inside a query parameter', () => {
  it('formats and key-safes a field of a tRPC input', () => {
    expect(formatLocation({ in: 'query', name: 'input', pointer: '/json/slug' })).toBe('query.input./json/slug')
    expect(formatLocation({ in: 'query', name: 'input' })).toBe('query.input')
    expect(keySafeLocation({ in: 'query', name: 'input', pointer: '/json/sess-1234567890abcdef/x' }, key => key.startsWith('sess-'))).toEqual({ in: 'query', name: 'input', pointer: '/json/{key}/x' })
  })
})
