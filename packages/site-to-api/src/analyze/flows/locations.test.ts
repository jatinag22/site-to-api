import { describe, expect, it } from 'vitest'
import { formatLocation, outputName, safePageUrl, slugify, uniqueName } from './locations'

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
