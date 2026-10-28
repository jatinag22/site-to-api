import { describe, expect, it } from 'vitest'
import { extractValue } from './value'

const LOGIN = `<!doctype html><html><head>
<meta name="csrf-token" content="abc.123">
</head><body>
<ul id="stores"><li><a href="/stores/pine-hill">Pine Hill</a></li><li><a href="/stores/cedar-park">Cedar Park</a></li></ul>
<p class="note">  Signed   in as <b>demo</b> </p>
</body></html>`

describe('extractValue', () => {
  it('reads an attribute', () => {
    expect(extractValue(LOGIN, { selector: 'meta[name="csrf-token"]', attr: 'content', pattern: null })).toBe('abc.123')
  })

  it('keeps the first capture group of a pattern and reads the first match of the selector', () => {
    expect(extractValue(LOGIN, { selector: '#stores > li > a', attr: 'href', pattern: '/stores/([\\w-]+)' })).toBe('pine-hill')
    expect(extractValue(LOGIN, { selector: '#stores > li:nth-of-type(2) > a', attr: 'href', pattern: '/stores/([\\w-]+)' })).toBe('cedar-park')
  })

  it('reads collapsed text when attr is null', () => {
    expect(extractValue(LOGIN, { selector: 'p.note', attr: null, pattern: null })).toBe('Signed in as demo')
  })

  it('returns null when the element, attribute or pattern does not match', () => {
    expect(extractValue(LOGIN, { selector: 'meta[name="missing"]', attr: 'content', pattern: null })).toBeNull()
    expect(extractValue(LOGIN, { selector: 'meta[name="csrf-token"]', attr: 'data-x', pattern: null })).toBeNull()
    expect(extractValue(LOGIN, { selector: '#stores a', attr: 'href', pattern: '^/items/(\\d+)' })).toBeNull()
  })

  it('throws a TypeError for an invalid selector or pattern', () => {
    expect(() => extractValue(LOGIN, { selector: 'a[', attr: null, pattern: null })).toThrow(TypeError)
    expect(() => extractValue(LOGIN, { selector: 'a', attr: null, pattern: '(' })).toThrow(TypeError)
  })
})
