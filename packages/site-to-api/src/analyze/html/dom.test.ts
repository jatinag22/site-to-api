import { describe, expect, it } from 'vitest'
import { holdsText, parseHtml, select } from './dom'

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
