import { describe, expect, it } from 'vitest'
import { applyExtractSpec, splitDelimited } from './apply'

describe('applyExtractSpec', () => {
  const page = '<div id="r-1" class="row"><b>A</b><i data-v="1">x</i></div><div class="row"><b>B</b></div><p id="total">Total: ₹1,200</p>'

  it('reads fields relative to each record, with the record itself for an empty selector', () => {
    expect(applyExtractSpec(page, {
      kind: 'html',
      records: 'div.row',
      many: true,
      fields: {
        name: {
          selector: 'b',
          attr: null,
          pattern: null,
          type: 'string',
          optional: false,
        },
        v: {
          selector: 'i',
          attr: 'data-v',
          pattern: null,
          type: 'integer',
          optional: true,
        },
        id: {
          selector: '',
          attr: 'id',
          pattern: 'r-(\\d+)',
          type: 'integer',
          optional: true,
        },
      },
    })).toEqual([
      { name: 'A', v: 1, id: 1 },
      { name: 'B', v: null, id: null },
    ])
  })

  it('uses the whole document for :root and the first match otherwise when many is false', () => {
    const total = {
      selector: '#total',
      attr: null,
      pattern: '₹\\s*([\\d,]+)',
      type: 'integer' as const,
      optional: false,
    }
    expect(applyExtractSpec(page, {
      kind: 'html',
      records: ':root',
      many: false,
      fields: { total },
    })).toEqual([
      { total: 1200 },
    ])
    expect(applyExtractSpec(page, {
      kind: 'html',
      records: 'div.row',
      many: false,
      fields: {
        name: {
          ...total,
          selector: 'b',
          pattern: null,
          type: 'string',
        },
      },
    })).toEqual([
      { name: 'A' },
    ])
    expect(applyExtractSpec(page, {
      kind: 'html',
      records: 'section',
      many: false,
      fields: { total },
    })).toEqual([])
  })

  it('splits delimited text, skipping the header, and matches patterns globally', () => {
    const csv = 'a,b\n1,"x, y"\n\n2,z\n'
    const fields = {
      a: {
        column: 0,
        group: null,
        type: 'integer' as const,
        optional: false,
      },
      b: {
        column: 1,
        group: null,
        type: 'string' as const,
        optional: false,
      },
    }
    expect(applyExtractSpec(csv, {
      kind: 'text',
      layout: 'delimited',
      delimiter: ',',
      header: true,
      pattern: null,
      fields,
    })).toEqual([
      { a: 1, b: 'x, y' },
      { a: 2, b: 'z' },
    ])
    expect(applyExtractSpec('k=1;k=2', {
      kind: 'text',
      layout: 'pattern',
      delimiter: null,
      header: false,
      pattern: 'k=(?<k>\\d)',
      fields: {
        k: {
          column: null,
          group: 'k',
          type: 'integer',
          optional: false,
        },
      },
    })).toEqual([
      { k: 1 },
      { k: 2 },
    ])
  })
})

describe('splitDelimited', () => {
  it('handles quotes, escaped quotes and multi-character delimiters', () => {
    expect(splitDelimited('"a ""b""",c', ',')).toEqual(['a "b"', 'c'])
    expect(splitDelimited('a||b', '||')).toEqual(['a', 'b'])
    expect(splitDelimited('|a|b|', '|')).toEqual(['', 'a', 'b', ''])
  })
})
