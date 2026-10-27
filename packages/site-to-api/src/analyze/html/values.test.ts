import { describe, expect, it } from 'vitest'
import { coerce, inferType, parseDate } from './values'

describe('coerce', () => {
  it('parses numbers with thousands separators and rejects symbols', () => {
    expect(coerce(' 1,299.50 ', 'number')).toBe(1299.5)
    expect(coerce('1,00,000', 'integer')).toBe(100000)
    expect(coerce('-12', 'integer')).toBe(-12)
    expect(coerce('₹12', 'number')).toBeNull()
    expect(coerce('12.5', 'integer')).toBeNull()
    expect(coerce('', 'string')).toBeNull()
  })

  it('parses yes/no and true/false booleans', () => {
    expect(coerce('Yes', 'boolean')).toBe(true)
    expect(coerce('n', 'boolean')).toBe(false)
    expect(coerce('maybe', 'boolean')).toBeNull()
  })

  it('normalises day-first and named-month dates to ISO and keeps ISO input', () => {
    expect(parseDate('05/03/2024')).toBe('2024-03-05')
    expect(parseDate('5-3-24')).toBe('2024-03-05')
    expect(parseDate('12 Mar 2024')).toBe('2024-03-12')
    expect(parseDate('March 12, 2024')).toBe('2024-03-12')
    expect(parseDate('2024-03-12T10:00:00Z')).toBe('2024-03-12T10:00:00Z')
    expect(parseDate('31/02/2024')).toBeNull()
    expect(parseDate('03/25/2024')).toBeNull()
    expect(parseDate('12 Marble 2024')).toBeNull()
  })
})

describe('inferType', () => {
  it('picks the narrowest type every value fits', () => {
    expect(inferType(['1', '20', ''])).toBe('integer')
    expect(inferType(['1', '2.5'])).toBe('number')
    expect(inferType(['Yes', 'no'])).toBe('boolean')
    expect(inferType(['01/02/2024', '2024-02-03'])).toBe('date')
    expect(inferType(['a', '1'])).toBe('string')
    expect(inferType([])).toBe('string')
  })

  it('keeps codes with leading zeros or too many digits as strings', () => {
    expect(inferType(['007', '123'])).toBe('string')
    expect(inferType(['1234567890123456'])).toBe('string')
  })
})
