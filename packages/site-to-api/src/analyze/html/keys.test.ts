import type { RawField } from './keys'
import { describe, expect, it } from 'vitest'
import { commonPrefix, idFromLinks, idFromRecordIds, isDerived } from './keys'

function field(raw: Array<string | null>, attr = 'href'): RawField {
  return {
    hints: { strong: [], weak: [] },
    selector: 'a',
    attr,
    pattern: null,
    raw,
    source: `a|${attr}`,
    shown: true,
  }
}

describe('commonPrefix', () => {
  it('is the longest shared start', () => {
    expect(commonPrefix(['item?id=1', 'item?id=22'])).toBe('item?id=')
    expect(commonPrefix([])).toBe('')
  })
})

describe('idFromLinks', () => {
  it('takes the number after a path or an id parameter', () => {
    expect(idFromLinks(field(['/products/1001-blue-kettle', '/products/1002-red-kettle']), [0, 0])).toMatchObject({
      pattern: '^/products/(\\d+)',
      raw: ['1001', '1002'],
    })
    expect(idFromLinks(field(['item?id=50275375', 'item?id=50275376']), [0, 0])?.raw).toEqual(['50275375', '50275376'])
  })

  it('takes no id from a date, a page number or a repeated link', () => {
    expect(idFromLinks(field(['front?day=2011-03-11', 'front?day=2015-06-09']), [0, 1])).toBeNull()
    expect(idFromLinks(field(['?p=2', '?p=3']), [0, 0])).toBeNull()
    expect(idFromLinks(field(['/u/1', '/u/1']), [0, 0])).toBeNull()
  })
})

describe('idFromRecordIds', () => {
  it('keeps the number of an id that names the record', () => {
    expect(idFromRecordIds(field(['question-summary-80013191', 'question-summary-80013205'], 'id'), [0, 0])).toMatchObject({
      pattern: '^question-summary-(\\d+)$',
      raw: ['80013191', '80013205'],
    })
    expect(idFromRecordIds(field(['50275375', '50275380'], 'id'), [0, 0])).toMatchObject({
      pattern: null,
      raw: ['50275375', '50275380'],
    })
  })

  it('rejects ids that count rows, from 0 or 1 in each sample', () => {
    expect(idFromRecordIds(field([
      'folder-row-0',
      'folder-row-1',
      'folder-row-2',
      'folder-row-0',
      'folder-row-1',
    ], 'id'), [0, 0, 0, 1, 1])).toBeNull()
    expect(idFromRecordIds(field(['row1', 'row2', 'row3'], 'id'), [0, 0, 0])).toBeNull()
  })

  it('rejects ids without a number', () => {
    expect(idFromRecordIds(field(['intro', 'usage'], 'id'), [0, 0])).toBeNull()
  })
})

describe('isDerived', () => {
  it('is true for one fixed text around the other field in each sample', () => {
    expect(isDerived(['vote?id=11&how=up', 'vote?id=12&how=up'], [11, 12], [0, 0])).toBe(true)
    expect(isDerived(['user?id=bob', 'user?id=ann'], ['bob', 'ann'], [0, 0])).toBe(true)
  })

  it('is false when the text around the value changes or the value is missing', () => {
    expect(isDerived(['/a/11/x', '/b/12/y'], [11, 12], [0, 0])).toBe(false)
    expect(isDerived(['item?id=11', 'item?id=99'], [11, 12], [0, 0])).toBe(false)
    expect(isDerived(['item?id=11', 'item?id=12'], [11, null], [0, 0])).toBe(false)
  })

  it('is false against a value that does not vary', () => {
    expect(isDerived(['/s?q=x', '/s?q=x'], ['x', 'x'], [0, 0])).toBe(false)
  })
})
