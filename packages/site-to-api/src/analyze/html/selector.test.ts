import { describe, expect, it } from 'vitest'
import { parseHtml, select } from './dom'
import { isStableId, stableClasses, uniqueSelector } from './selector'

describe('selectors', () => {
  it('rejects generated ids and hashed classes', () => {
    expect(isStableId('products')).toBe(true)
    expect(isStableId(':r1:')).toBe(false)
    expect(isStableId('ember1234')).toBe(false)
    const [element] = select('span', parseHtml('<span class="price css-1x2y3z _3fG7k Card_price__a1B2c col-2"></span>'))
    expect(element && stableClasses(element)).toEqual(['price', 'col-2'])
  })

  it('rejects CSS-module hashes but keeps BEM elements', () => {
    const [element] = select('span', parseHtml('<span class="NarrowOnly__KfauzV OverviewTable__rPbUfl Box__a1b2c prc-Token-Token-A5-r7 card__title card__priceValue Link--primary"></span>'))
    expect(element && stableClasses(element)).toEqual(['card__title', 'card__priceValue', 'Link--primary'])
  })

  it('anchors on a data attribute before a class with a `__` part', () => {
    const document = parseHtml('<ul class="withMetadata__klorrw" data-density="normal"><li>a</li></ul><ul><li>b</li></ul>')
    expect(uniqueSelector(select('ul', document)[0]!, document)).toBe('ul[data-density]')
  })

  it('keeps BEM elements of camelCase and PascalCase blocks', () => {
    const [element] = select('span', parseHtml('<span class="ProductCard__title searchResult__price UserCard__author withMetadata__klorrw"></span>'))
    expect(element && stableClasses(element)).toEqual([
      'ProductCard__title',
      'searchResult__price',
      'UserCard__author',
      'withMetadata__klorrw',
    ])
  })

  it('prefers id, then name, then a unique class, then an anchored path', () => {
    const document = parseHtml('<div id="main"><form><input name="q"><span class="a">1</span><span class="a">2</span><em>x</em><em>y</em></form></div>')
    const [input, , second, , em] = select('input, span, em', document)
    expect(input && uniqueSelector(input, document)).toBe('input[name="q"]')
    expect(second && uniqueSelector(second, document)).toBe('#main > form:nth-of-type(1) > span:nth-of-type(2)')
    expect(em && uniqueSelector(em, document)).toBe('#main > form:nth-of-type(1) > em:nth-of-type(2)')
    expect(uniqueSelector(select('div', document)[0]!, document)).toBe('#main')
  })
})
