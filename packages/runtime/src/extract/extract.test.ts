// @vitest-environment happy-dom
import type { ExtractedRecord } from './extract'
import type { ExtractField, ExtractSpec, HtmlExtractSpec, TextExtractSpec } from './types'
import { describe, expect, it } from 'vitest'
import { domEngine } from './dom'
import { extractWith } from './extract'
import { htmlparser2Engine } from './htmlparser2'
import { extract } from './index'

type Run = (text: string, spec: ExtractSpec) => ExtractedRecord[] | ExtractedRecord

/** htmlparser2 (Node, workers) and the browser's DOMParser, here happy-dom's. */
const ENGINES: Array<[string, Run]> = [
  [
    'htmlparser2',
    (text, spec) => extractWith(htmlparser2Engine, text, spec),
  ],
  [
    'DOMParser',
    (text, spec) => extractWith(domEngine, text, spec),
  ],
]

function field(selector: string, overrides: Partial<ExtractField> = {}): ExtractField {
  return {
    selector,
    attr: null,
    pattern: null,
    type: 'string',
    optional: false,
    ...overrides,
  }
}

const LIST_HTML = `
<html><body>
  <table class="prices">
    <tbody>
      <tr data-id="a1">
        <td class="name">  Alpha
          Widget </td>
        <td class="price">₹1,234.50</td>
        <td class="change">+2.5%</td>
        <td><a href="/items/a1">view</a></td>
      </tr>
      <tr data-id="b2">
        <td class="name">Beta</td>
        <td class="price">n/a</td>
        <td class="change">-1%</td>
      </tr>
    </tbody>
  </table>
</body></html>`

// Every HTML case runs on both engines, so they cannot drift apart (decision 0058).
describe.each(ENGINES)('extract (html) with %s', (_engine, run) => {
  const spec: HtmlExtractSpec = {
    kind: 'html',
    records: 'table.prices tbody tr',
    many: true,
    fields: {
      id: field('', { attr: 'data-id' }),
      name: field('td.name'),
      price: field('td.price', { type: 'number' }),
      change: field('td.change', { type: 'number' }),
      link: field('a', { attr: 'href', optional: true }),
      slug: field('a', { attr: 'href', pattern: '/items/(\\w+)', optional: true }),
      note: field('td.note'),
    },
  }

  it('reads one record per match with relative selectors, attributes and patterns', () => {
    expect(run(LIST_HTML, spec)).toEqual([
      {
        id: 'a1',
        name: 'Alpha Widget',
        price: 1234.5,
        change: 2.5,
        link: '/items/a1',
        slug: 'a1',
        note: null,
      },
      {
        id: 'b2',
        name: 'Beta',
        price: null,
        change: -1,
        note: null,
      },
    ])
  })

  it('returns one record for many: false, with ":root" meaning the whole page', () => {
    const detail: HtmlExtractSpec = {
      kind: 'html',
      records: ':root',
      many: false,
      fields: {
        title: field('h1'),
        price: field('.price', { pattern: 'Price: ([\\d.,]+)', type: 'number' }),
        inStock: field('.stock', { type: 'boolean' }),
        listed: field('time', { attr: 'datetime', type: 'date' }),
        missing: field('.nothing', { optional: true }),
      },
    }
    const html = '<h1>Gadget</h1><p class="price">Price: 1,999</p><span class="stock">Yes</span><time datetime="2026-03-12">12 March</time>'
    expect(run(html, detail)).toEqual({
      title: 'Gadget',
      price: 1999,
      inStock: true,
      listed: '2026-03-12',
    })
  })

  it('returns the first match for many: false and nulls when nothing matches', () => {
    const first: HtmlExtractSpec = {
      kind: 'html',
      records: 'tr',
      many: false,
      fields: {
        name: field('td.name'),
        x: field('i', { optional: true }),
      },
    }
    expect(run(LIST_HTML, first)).toEqual({ name: 'Alpha Widget' })
    expect(run('<p>empty</p>', first)).toEqual({ name: null })
  })

  it('reads the sibling rows of a record that spans several rows through :scope selectors', () => {
    const page = '<table><tr class="athing" id="11"><td><a href="https://a.example">Alpha</a></td></tr><tr><td><span class="score">7 points</span></td></tr><tr class="spacer"></tr>'
      + '<tr class="athing" id="12"><td><a href="https://b.example">Beta</a></td></tr><tr><td>job ad</td></tr><tr class="spacer"></tr></table>'
    expect(run(page, {
      kind: 'html',
      records: 'tr.athing',
      many: true,
      recordsName: 'submissions',
      fields: {
        id: field('', { attr: 'id', type: 'integer' }),
        title: field('a'),
        score: field(':scope + tr:not(.athing) span.score', { pattern: '(\\d+)', type: 'integer', optional: true }),
      },
    })).toEqual([
      { id: 11, title: 'Alpha', score: 7 },
      { id: 12, title: 'Beta' },
    ])
  })

  it('builds records without a prototype, so field names like constructor and __proto__ are plain keys', () => {
    const records = run('<ul><li><b>A</b><i>x</i></li><li><b>B</b></li></ul>', {
      kind: 'html',
      records: 'li',
      many: true,
      fields: {
        constructor: field('i', { optional: true }),
        // A computed key: a literal `__proto__:` would set the object's prototype instead.
        ['__proto__']: field('b'),
      },
    })
    expect(Array.isArray(records) && records.map(record => [
      Object.hasOwn(record, 'constructor'),
      record.constructor,
      Object.hasOwn(record, '__proto__'),
    ])).toEqual([
      [true, 'x', true],
      [false, undefined, true],
    ])
  })

  it('returns an empty array when no record matches', () => {
    expect(run('<p>none</p>', spec)).toEqual([])
  })

  it('treats a pattern that does not match as a missing field', () => {
    const noMatch: HtmlExtractSpec = {
      kind: 'html',
      records: 'tr',
      many: true,
      fields: {
        code: field('td.name', { pattern: '(\\d+)' }),
      },
    }
    expect(run(LIST_HTML, noMatch)).toEqual([
      { code: null },
      { code: null },
    ])
  })

  it('throws a clear error for an invalid selector or pattern', () => {
    // Invalid selectors are checked on htmlparser2 only, below: browsers throw a SyntaxError for
    // them, but happy-dom, which stands in for a browser here, accepts them.
    expect(() => run(LIST_HTML, {
      ...spec,
      fields: {
        a: field('td', { pattern: '(' }),
      },
    })).toThrow(/invalid pattern for field "a"/)
  })

  it('reads table rows the same whether the page wrote <tbody> or the parser added it', () => {
    const page = '<table class="t"><tr><td class="n">A</td></tr><tr><td class="n">B</td></tr></table>'
    expect(run(page, {
      kind: 'html',
      records: 'table.t > tr',
      many: true,
      fields: {
        n: field('td.n'),
      },
    })).toEqual([
      { n: 'A' },
      { n: 'B' },
    ])
  })

  it('reads label rows through :contains(), as build writes them', () => {
    const page = '<dl><dt>Phone</dt><dd>12 34</dd><dt>Address</dt><dd> 1 "Main" St </dd></dl>'
    expect(run(page, {
      kind: 'html',
      records: ':root',
      many: false,
      fields: {
        phone: field('dt:contains("Phone") + dd'),
        address: field('dt:contains("Address") + dd'),
      },
    })).toEqual({ phone: '12 34', address: '1 "Main" St' })
  })
})

describe('extract (html) selector errors', () => {
  it('names the records or field selector that does not parse', () => {
    expect(() => extractWith(htmlparser2Engine, LIST_HTML, {
      kind: 'html',
      records: 'tr[',
      many: true,
      fields: {},
    })).toThrow(/invalid CSS selector for records/)
  })
})

describe('extract (text)', () => {
  it('reads delimited text with a header row and quoted fields', () => {
    const spec: TextExtractSpec = {
      kind: 'text',
      layout: 'delimited',
      delimiter: ',',
      header: true,
      pattern: null,
      fields: {
        name: {
          column: 0,
          group: null,
          type: 'string',
          optional: false,
        },
        price: {
          column: 1,
          group: null,
          type: 'number',
          optional: false,
        },
        note: {
          column: 3,
          group: null,
          type: 'string',
          optional: true,
        },
      },
    }
    const csv = 'name,price,qty\n"Widget, large","$1,200",3\n\nGadget,5,1\n'
    expect(extract(csv, spec)).toEqual([
      { name: 'Widget, large', price: 1200 },
      { name: 'Gadget', price: 5 },
    ])
  })

  it('defaults the delimiter to a comma and supports other delimiters', () => {
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
    const base: TextExtractSpec = {
      kind: 'text',
      layout: 'delimited',
      delimiter: null,
      header: false,
      pattern: null,
      fields,
    }
    expect(extract('1,x', base)).toEqual([
      { a: 1, b: 'x' },
    ])
    expect(extract('2|y\r\n3|z', { ...base, delimiter: '|' })).toEqual([
      { a: 2, b: 'y' },
      { a: 3, b: 'z' },
    ])
  })

  it('matches a global pattern with named groups, one record per match', () => {
    const spec: TextExtractSpec = {
      kind: 'text',
      layout: 'pattern',
      delimiter: null,
      header: false,
      pattern: '^(?<symbol>[A-Z]+): (?<price>[\\d.]+)(?: \\((?<note>[^)]*)\\))?$',
      fields: {
        symbol: {
          column: null,
          group: 'symbol',
          type: 'string',
          optional: false,
        },
        price: {
          column: null,
          group: 'price',
          type: 'number',
          optional: false,
        },
        note: {
          column: null,
          group: 'note',
          type: 'string',
          optional: true,
        },
      },
    }
    expect(extract('ABC: 1.5 (halted)\nXYZ: 20\nnoise', spec)).toEqual([
      { symbol: 'ABC', price: 1.5, note: 'halted' },
      { symbol: 'XYZ', price: 20 },
    ])
  })

  it('throws when a pattern layout has no pattern', () => {
    const spec: TextExtractSpec = {
      kind: 'text',
      layout: 'pattern',
      delimiter: null,
      header: false,
      pattern: null,
      fields: {},
    }
    expect(() => extract('x', spec)).toThrow(/needs a pattern/)
  })
})
