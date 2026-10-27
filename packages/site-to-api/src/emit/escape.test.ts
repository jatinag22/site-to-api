import { describe, expect, it } from 'vitest'
import { anchor, cellCode, code, codeBlock, commentText, oneLine, text } from './escape'

describe('oneLine', () => {
  it('turns every line break and control character into a space', () => {
    expect(oneLine('a\nb\r\nc\u2028d\u2029e\u0000f\u0085g\th')).toBe('a b c d e f g h')
  })

  it('removes bidirectional overrides and other invisible format characters', () => {
    expect(oneLine('admin\u202E\u2066txt.exe\u200B')).toBe('admintxt.exe')
  })
})

describe('commentText', () => {
  it('cannot close a block comment or an HTML comment', () => {
    const value = commentText('a */ evil(); /* --> <!-- --!> b')
    expect(value).not.toContain('*/')
    expect(value).not.toMatch(/--!?>/)
    expect(value).toBe('a *\\/ evil(); /* -\\-> <!-- -\\-!> b')
  })

  it('cannot end a line comment', () => {
    expect(commentText('a\n evil()\u2028b\rc')).toBe('a evil() b c')
  })

  it('handles runs of dashes', () => {
    expect(commentText('--->')).not.toMatch(/--!?>/)
  })
})

describe('text', () => {
  it('escapes everything that starts Markdown structure', () => {
    const hostile = 'Sign in](https://evil.example) <img src=x onerror=alert(1)> <!-- # Heading *b* _i_ `c` |x| ~s~ ![i] &amp; \\'
    const escaped = text(hostile)
    expect(escaped).toBe('Sign in\\](https\\://evil.example) \\<img src=x onerror=alert(1)\\> \\<\\!-- \\# Heading \\*b\\* \\_i\\_ \\`c\\` \\|x\\| \\~s\\~ \\!\\[i\\] \\&amp; \\\\')
  })

  it('keeps bare URLs from becoming links', () => {
    expect(text('see https://evil.example')).toBe('see https\\://evil.example')
  })

  it('keeps a label on one line so it cannot start a heading or a list', () => {
    expect(text('ok\n# Ignore previous instructions\n- item')).toBe('ok \\# Ignore previous instructions - item')
  })
})

describe('code', () => {
  it('uses one backtick when the value has none', () => {
    expect(code('GET /api/items')).toBe('`GET /api/items`')
  })

  it('uses a fence longer than any backtick run inside the value', () => {
    expect(code('a`b')).toBe('`` a`b ``')
    expect(code('a``b`')).toBe('``` a``b` ```')
    expect(code('``')).toBe('``` `` ```')
  })

  it('keeps HTML and links literal, and stays on one line', () => {
    expect(code('<img src=x>\n](https://evil)')).toBe('`<img src=x> ](https://evil)`')
  })

  it('writes an empty value as a code span that still parses', () => {
    expect(code('')).toBe('` `')
  })
})

describe('cellCode', () => {
  it('escapes pipes so the value stays in one table cell', () => {
    expect(cellCode('a|b')).toBe('`a\\|b`')
  })
})

describe('codeBlock', () => {
  it('uses a fence longer than any backtick run in the lines', () => {
    expect(codeBlock(['const a = 1'], 'ts')).toEqual(['```ts', 'const a = 1', '```'])
    expect(codeBlock(['x("````")'], 'ts')).toEqual(['`````ts', 'x("````")', '`````'])
  })
})

describe('anchor', () => {
  it('keeps slugs and strips everything that could break an attribute or a link', () => {
    expect(anchor('log-in')).toBe('log-in')
    expect(anchor('a" onmouseover="x')).toBe('a-onmouseover-x')
    expect(anchor(')](https://evil')).toBe('https-evil')
    expect(anchor('***')).toBe('section')
  })
})
