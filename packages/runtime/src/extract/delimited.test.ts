import { describe, expect, it } from 'vitest'
import { parseDelimited } from './delimited'

describe('parseDelimited', () => {
  it('splits rows and columns', () => {
    expect(parseDelimited('a,b\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('handles quoted delimiters, doubled quotes and line breaks inside quotes', () => {
    expect(parseDelimited('"a,1","say ""hi""","two\nlines"\n', ',')).toEqual([
      ['a,1', 'say "hi"', 'two\nlines'],
    ])
  })

  it('keeps empty fields and skips blank lines', () => {
    expect(parseDelimited('a,,c\n\n\r\n,b,\n', ',')).toEqual([
      ['a', '', 'c'],
      ['', 'b', ''],
    ])
  })

  it('supports multi-character delimiters and tabs', () => {
    expect(parseDelimited('a::b', '::')).toEqual([
      ['a', 'b'],
    ])
    expect(parseDelimited('a\tb', '\t')).toEqual([
      ['a', 'b'],
    ])
  })

  it('treats a quote in the middle of a field as a literal', () => {
    expect(parseDelimited('5" screen,x', ',')).toEqual([
      ['5" screen', 'x'],
    ])
  })

  it('returns nothing for empty input', () => {
    expect(parseDelimited('', ',')).toEqual([])
  })
})
