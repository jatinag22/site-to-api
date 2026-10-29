import { describe, expect, it } from 'vitest'
import { typeField } from './fields'

describe('typeField', () => {
  it('strips currency prefixes and unit suffixes with a pattern', () => {
    expect(typeField(['₹1,299.00', '₹899.50'])).toEqual({ type: 'number', pattern: '₹\\s*([+-]?\\d[\\d,]*(?:\\.\\d+)?)' })
    expect(typeField(['45%', '50%'])).toEqual({ type: 'integer', pattern: '([+-]?\\d[\\d,]*)\\s*%' })
    expect(typeField(['4.5 / 5', '3.9 / 5'])).toEqual({ type: 'number', pattern: '([+-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*/\\s*5' })
  })

  it('finds a lone number among currency or unit words', () => {
    expect(typeField(['Rs. 50', '₹ 75 each'])).toEqual({ type: 'integer', pattern: '([+-]?\\d[\\d,]*(?:\\.\\d+)?)' })
    expect(typeField(['Pan 3', 'Kettle 2000'])).toEqual({ type: 'string', pattern: null })
  })

  it('keeps identifiers as strings and strips shared labels', () => {
    expect(typeField(['SKU-1001', 'SKU-2001'])).toEqual({ type: 'string', pattern: null })
    expect(typeField(['Seller: Acme', 'Seller: Green Things'])).toEqual({ type: 'string', pattern: '^\\s*Seller:\\s*([\\s\\S]+?)\\s*$' })
    expect(typeField(['plain', 'words'])).toEqual({ type: 'string', pattern: null })
    expect(typeField(['12', '13'])).toEqual({ type: 'integer', pattern: null })
  })

  it('reads counts with a singular or plural noun, words without a number as null', () => {
    expect(typeField(['12 points', '1 point'])).toEqual({ type: 'integer', pattern: '([+-]?\\d[\\d,]*)\\s*points?', unit: 'points' })
    expect(typeField(['5\u00A0comments', 'discuss', '1 comment'])).toMatchObject({ type: 'integer', unit: 'comments' })
    expect(typeField(['4.1 out of 5 stars', '3.8 out of 5 stars'])).toMatchObject({ type: 'number', unit: 'rating' })
  })

  it('keeps relative times and URLs as strings', () => {
    expect(typeField(['3 hours ago', '5 hours ago'])).toEqual({ type: 'string', pattern: null })
    expect(typeField(['https://a.example/x', 'https://b.example/y'])).toEqual({ type: 'string', pattern: null })
  })
})
