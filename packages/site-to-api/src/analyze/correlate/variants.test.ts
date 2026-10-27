import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { variantsOf } from './variants'

describe('variantsOf', () => {
  it('starts with the value itself', () => {
    expect(variantsOf('abc-value', 4)[0]).toEqual({ value: 'abc-value', transform: 'none' })
  })

  it('includes URL, JSON-string and base64 forms in both directions', () => {
    const forms = variantsOf('a b"c', 4)
    expect(forms).toContainEqual({ value: 'a%20b%22c', transform: 'url-encoded' })
    expect(forms).toContainEqual({ value: 'a b\\"c', transform: 'json-string' })
    expect(forms).toContainEqual({
      value: Buffer.from('a b"c').toString('base64'),
      transform: 'base64',
    })
    expect(variantsOf(Buffer.from('decoded-text').toString('base64'), 4)).toContainEqual({ value: 'decoded-text', transform: 'base64' })
    expect(variantsOf('a%20b%2Fc', 4)).toContainEqual({ value: 'a b/c', transform: 'url-encoded' })
  })

  it('does not treat binary garbage as a decoded base64 value', () => {
    const forms = variantsOf(Buffer.from([0, 1, 2, 3, 255, 254]).toString('base64'), 4)
    expect(forms.filter(form => form.transform === 'base64').every(form => /^[\w+/=-]+$/.test(form.value))).toBe(true)
  })

  it('skips forms shorter than the minimum length and duplicates', () => {
    const forms = variantsOf('plainvalue', 4)
    expect(new Set(forms.map(form => form.value)).size).toBe(forms.length)
    expect(variantsOf('abcd', 8).map(form => form.transform)).toEqual(['none', 'base64'])
  })
})
