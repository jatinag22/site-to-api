import { describe, expect, it } from 'vitest'
import { parseHtml, select } from './dom'
import { hasHeadingRows, markers, partsOf, repeatedGroups, spanningGroups, tableGroups } from './groups'

function first(html: string, selector: string) {
  const [element] = select(selector, parseHtml(html))
  if (!element)
    throw new Error(`no ${selector}`)
  return element
}

/** A table of rows; each row is its class (or `''`) and its cells. */
function table(rows: Array<[string, string[]]>): string {
  return `<html><body><table id="t">${rows.map(([name, cells]) => `<tr${name === ''
    ? ''
    : ` class="${name}"`}>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table></body></html>`
}

describe('markers', () => {
  it('takes short shared values and data attributes with their own values', () => {
    const card = first('<div role="listitem" data-component-type="search-result" data-asin="B0DQ212KP4" data-index="3" class="x" aria-label="Card"></div>', 'div')
    expect(markers(card)).toEqual([
      '[role="listitem"]',
      '[data-component-type="search-result"]',
      '[data-asin]',
    ])
  })

  it('ignores ids, links, styling, aria and values that look like ids', () => {
    const card = first('<div id="c1" href="/x" style="color:red" aria-hidden="true" data-uuid="ab" data-v="item-12345" title="Card"></div>', 'div')
    expect(markers(card)).toEqual(['[data-v]'])
  })
})

describe('repeatedGroups', () => {
  it('groups siblings by class signature and by a shared marker', () => {
    const page = (n: number) => `<html><body><div id="list">${Array.from({ length: n }, (_, i) => `<div class="card col-${i % 2 === 0
      ? 'a'
      : 'b'}" data-kind="product">${i}</div>`).join('')}</div></body></html>`
    const selectors = repeatedGroups([
      parseHtml(page(4)),
      parseHtml(page(3)),
    ]).map(group => group.selector)
    expect(selectors).toEqual(expect.arrayContaining([
      '#list > div.card.col-a',
      '#list > div.card.col-b',
      '#list > div[data-kind="product"]',
    ]))
  })
})

describe('spanningGroups', () => {
  it('anchors a record on a repeated row and takes the rows up to the next one', () => {
    const page = table([
      [
        'story',
        ['1.', 'A'],
      ],
      [
        '',
        ['7 points'],
      ],
      ['spacer', []],
      [
        'story',
        ['2.', 'B'],
      ],
      [
        '',
        ['9 points'],
      ],
      ['spacer', []],
    ])
    const [group] = spanningGroups([
      parseHtml(page),
    ])
    expect(group).toMatchObject({
      selector: '#t > tr.story',
      kind: 'spanning',
      companions: [
        ':scope + tr:not(.story)',
        ':scope + tr:not(.story) + tr:not(.story)',
      ],
    })
    const [record] = select(group?.selector ?? '', parseHtml(page))
    expect(record && partsOf(record, group?.companions ?? []).map(part => part?.attribs.class ?? '')).toEqual(['story', '', 'spacer'])
  })

  it('finds no anchor in alternating rows of one shape', () => {
    const page = table([
      [
        'odd',
        ['A', '1'],
      ],
      [
        'even',
        ['B', '2'],
      ],
      [
        'odd',
        ['C', '3'],
      ],
      [
        'even',
        ['D', '4'],
      ],
    ])
    expect(spanningGroups([
      parseHtml(page),
    ])).toEqual([])
  })

  it('rejects headings over entries, in equal and uneven numbers', () => {
    const grouped = (sizes: number[]) => table(sizes.flatMap((count, day) => [
      [
        'day',
        [`Day ${day + 1}`],
      ] as [string, string[]],
      ...Array.from({ length: count }, (_, i): [string, string[]] => [
        '',
        [`Payee ${day}${i}`, `${i * 3}`, `${i}`],
      ]),
    ]))
    expect(spanningGroups([
      parseHtml(grouped([3, 3, 3])),
    ])).toEqual([])
    expect(spanningGroups([
      parseHtml(grouped([4, 4, 4])),
    ])).toEqual([])
    expect(spanningGroups([
      parseHtml(grouped([1, 3, 2, 2, 1, 4])),
    ])).toEqual([])
  })
})

describe('tableGroups', () => {
  it('reads rows with cells and skips heading rows that span the table', () => {
    const page = '<html><body><table id="t"><tr><th>Name</th><th>Amount</th></tr><tr class="day"><td colspan="2">Day 1</td></tr><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></table></body></html>'
    const document = parseHtml(page)
    expect(hasHeadingRows(select('table', document)[0]!)).toBe(true)
    const [group] = tableGroups([document])
    expect(group?.selector).toBe('#t tr:has(> td + td)')
    expect(group && [
      ...group.headers.values(),
    ]).toEqual(['Name', 'Amount'])
    expect(select(group?.selector ?? '', document)).toHaveLength(2)
  })

  it('leaves label/value tables to detail extraction', () => {
    const page = '<html><body><table id="t"><tr><th>Name</th><td>Ann</td></tr><tr><th>Age</th><td>4</td></tr></table></body></html>'
    expect(tableGroups([
      parseHtml(page),
    ])).toEqual([])
  })
})
