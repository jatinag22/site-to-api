import { describe, expect, it } from 'vitest'
import { exchange } from '../../test/helpers'
import { inHostFilter, unmatchedHostPatterns } from './hosts'

const captured = [
  exchange({ url: 'http://localhost:4173/api/categories' }),
  exchange({ url: 'https://api.shop.test/v1/items' }),
]

describe('unmatchedHostPatterns', () => {
  it('warns about include and exclude patterns that match no captured host', () => {
    expect(unmatchedHostPatterns(captured, {
      include: ['localhost:9999', '*.shop.test'],
      exclude: ['cdn.other.test'],
    })).toEqual([
      'hosts.include pattern "localhost:9999" matches no captured host (captured: api.shop.test, localhost:4173). Check it for a typo; host patterns are globs such as *.example.com, and a pattern with a port only matches that port.',
      'hosts.exclude pattern "cdn.other.test" matches no captured host (captured: api.shop.test, localhost:4173). Check it for a typo; host patterns are globs such as *.example.com, and a pattern with a port only matches that port.',
    ])
  })

  it('is silent when every pattern matches, including a pattern without a port', () => {
    expect(unmatchedHostPatterns(captured, {
      include: ['localhost', 'api.shop.test'],
      exclude: [],
    })).toEqual([])
  })
})

describe('inHostFilter', () => {
  it('keeps every host without an include list, minus excluded ones', () => {
    const wanted = inHostFilter({
      include: [],
      exclude: ['cdn.*'],
    })
    expect(wanted('localhost:4173')).toBe(true)
    expect(wanted('cdn.shop.test')).toBe(false)
  })

  it('keeps only included hosts when an include list is given', () => {
    const wanted = inHostFilter({
      include: ['localhost:9999'],
      exclude: [],
    })
    expect(wanted('localhost:4173')).toBe(false)
    expect(wanted('localhost:9999')).toBe(true)
  })
})
