import { describe, expect, it } from 'vitest'
import { parseHtml, select } from './dom'
import { classHint, linkWord, recordKind } from './hints'
import { NameAllocator, plural, singular } from './naming'

function first(html: string, selector: string) {
  const [element] = select(selector, parseHtml(html))
  if (!element)
    throw new Error(`no ${selector}`)
  return element
}

describe('classHint', () => {
  it('cleans record prefixes, BEM parts, design-system prefixes and glued endings', () => {
    expect(classHint('card-title', ['card'])).toBe('title')
    expect(classHint('s-post-summary--content-excerpt', [])).toBe('excerpt')
    expect(classHint('titleline', [])).toBe('title')
    expect(classHint('sitestr', [])).toBe('site')
    expect(classHint('headline', [])).toBe('headline')
    expect(classHint('a-price', [])).toBe('price')
  })

  it('prefers the link noun a class ends with and ignores styling classes', () => {
    expect(classHint('hnuser', [], 'user')).toBe('user')
    expect(classHint('Link--primary', [])).toBeNull()
    expect(classHint('text-truncate', [])).toBeNull()
    expect(classHint('a-offscreen', [])).toBeNull()
  })
})

describe('linkWord', () => {
  it('takes the noun a link points at, or a query parameter that is not an id', () => {
    expect(linkWord('user?id=')).toBe('user')
    expect(linkWord('/users/')).toBe('user')
    expect(linkWord('from?site=')).toBe('site')
    expect(linkWord('http')).toBeNull()
    expect(linkWord('https://')).toBeNull()
  })
})

describe('recordKind', () => {
  it('reads the schema.org type of the record or its main item', () => {
    expect(recordKind(first('<div itemtype="https://schema.org/ListItem"><div itemscope itemtype="https://schema.org/Question"></div></div>', 'div'), null)).toBe('question')
  })

  it('uses the last meaningful class, skipping utilities, then the container', () => {
    expect(recordKind(first('<table><tr class="athing submission"></tr></table>', 'tr'), null)).toBe('submission')
    expect(recordKind(first('<div class="bb bc-black-200 py16"></div>', 'div'), null)).toBeNull()
    const table = first('<table class="deals"><tr><td>1</td></tr></table>', 'table')
    expect(recordKind(first('<table class="deals"><tr><td>1</td></tr></table>', 'tr'), table)).toBe('deal')
  })
})

describe('naming', () => {
  it('pluralises and singularises simple English nouns', () => {
    expect(['story', 'box', 'deal', 'question'].map(plural)).toEqual([
      'stories',
      'boxes',
      'deals',
      'questions',
    ])
    expect(['stories', 'boxes', 'deals', 'status'].map(singular)).toEqual(['story', 'box', 'deal', 'status'])
  })

  it('takes the first free hint before numbering one', () => {
    const names = new NameAllocator()
    expect(names.takeFree(['user'])).toBe('user')
    expect(names.takeFree(['user', 'author'])).toBe('author')
    expect(names.takeFree(['user'])).toBe('user2')
    expect(names.takeFree([null])).toBe('field1')
  })
})
