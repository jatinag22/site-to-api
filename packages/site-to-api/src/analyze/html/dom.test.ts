import { extract } from 'site-to-api-runtime'
import { describe, expect, it } from 'vitest'
import { cssIdent, holdsText, parseHtml, select, tagSelector } from './dom'

function first(html: string) {
  const [element] = select('span', parseHtml(html))
  if (!element)
    throw new Error('no span')
  return element
}

describe('holdsText', () => {
  it('is false for glue between children', () => {
    expect(holdsText(first('<span><b>12 points</b> by <a>bob</a> | <a>hide</a></span>'))).toBe(false)
    expect(holdsText(first('<span> (<a>example.com</a>)</span>'))).toBe(false)
    expect(holdsText(first('<span><a>x</a></span>'))).toBe(false)
  })

  it('is true for a leaf, for numbers and for words around children', () => {
    expect(holdsText(first('<span>by</span>'))).toBe(true)
    expect(holdsText(first('<span><i>★</i> 4</span>'))).toBe(true)
    expect(holdsText(first('<span>Shipped from <b>Pune</b> warehouse</span>'))).toBe(true)
  })
})

describe('cssIdent', () => {
  it('escapes like CSS.escape', () => {
    expect(cssIdent('price')).toBe('price')
    expect(cssIdent('dptags:querylogoperation')).toBe('dptags\\:querylogoperation')
    expect(cssIdent('a.b')).toBe('a\\.b')
    expect(cssIdent('1x:y')).toBe('\\31 x\\:y')
    expect(cssIdent('-2a')).toBe('-\\32 a')
    expect(cssIdent('-')).toBe('\\-')
    expect(cssIdent('a\u0001b')).toBe('a\\1 b')
    expect(cssIdent('café-ü')).toBe('café-ü')
  })
})

describe('selectors built from odd names', () => {
  const page = '<div><dptags:queryLogOperation op="a"></dptags:queryLogOperation><x-y.z>q</x-y.z>'
    + '<p class="a.b w-1/2 [x]" id="1x:y">t</p><p id="-">u</p></div>'

  it('match the element in css-select and in the runtime extract()', () => {
    const document = parseHtml(page)
    const selectors = [
      ...select('*', document).map(tagSelector),
      `p.${cssIdent('a.b')}`,
      `p.${cssIdent('w-1/2')}`,
      `p.${cssIdent('[x]')}`,
      `#${cssIdent('1x:y')}`,
      `#${cssIdent('-')}`,
    ]
    for (const selector of selectors) {
      const count = select(selector, document).length
      expect(count, selector).toBeGreaterThan(0)
      expect(extract(page, {
        kind: 'html',
        records: selector,
        many: true,
        fields: {
          v: {
            selector: '',
            attr: null,
            pattern: null,
            type: 'string',
            optional: false,
          },
        },
      }), selector).toHaveLength(count)
    }
  })
})
