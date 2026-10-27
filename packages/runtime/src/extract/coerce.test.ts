import { describe, expect, it } from 'vitest'
import { coerce } from './coerce'

describe('coerce', () => {
  it('keeps strings as they are', () => {
    expect(coerce(' a b ', 'string')).toBe(' a b ')
  })

  it.each([
    ['₹1,23,456.78', 123456.78],
    ['$ 1,200', 1200],
    ['€9.99', 9.99],
    ['£0.5', 0.5],
    ['12.5%', 12.5],
    ['-3', -3],
    ['+4', 4],
    ['(1,000.25)', -1000.25],
    ['1e3', 1000],
    ['.5', 0.5],
  ])('reads number %s', (raw, expected) => {
    expect(coerce(raw, 'number')).toBe(expected)
  })

  it.each(['', 'n/a', '1.2.3', '12abc', '--1'])('returns null for unreadable number %j', (raw) => {
    expect(coerce(raw, 'number')).toBeNull()
  })

  it('reads integers and rejects fractions', () => {
    expect(coerce('1,024', 'integer')).toBe(1024)
    expect(coerce('12.0', 'integer')).toBe(12)
    expect(coerce('12.5', 'integer')).toBeNull()
  })

  it('reads booleans in common spellings', () => {
    expect(['true', 'Yes', 'y', '1', 'ON', '✓'].map(raw => coerce(raw, 'boolean'))).toEqual([true, true, true, true, true, true])
    expect(['false', 'No', 'n', '0', 'off', '✗'].map(raw => coerce(raw, 'boolean'))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ])
    expect(coerce('maybe', 'boolean')).toBeNull()
  })

  it.each([
    ['2026-03-12', '2026-03-12'],
    ['2026-03-12T10:30:00Z', '2026-03-12T10:30:00.000Z'],
    ['2026-03-12 10:30', '2026-03-12T10:30:00.000Z'],
    ['2026-03-12T10:30:00+0530', '2026-03-12T05:00:00.000Z'],
    ['12 Mar 2026', '2026-03-12'],
    ['12-Mar-2026', '2026-03-12'],
    ['1 Sept. 2026', '2026-09-01'],
    ['March 12, 2026', '2026-03-12'],
    ['Mar 3rd 2026', '2026-03-03'],
  ])('reads date %s as ISO', (raw, expected) => {
    expect(coerce(raw, 'date')).toBe(expected)
  })

  it.each([
    '03/04/2026',
    'tomorrow',
    '2026-02-30',
    '31 Foo 2026',
    '30 Feb 2026',
  ])('keeps unreadable or ambiguous date %s as text', (raw) => {
    expect(coerce(raw, 'date')).toBe(raw)
  })
})
