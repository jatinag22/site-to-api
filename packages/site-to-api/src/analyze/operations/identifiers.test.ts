import { describe, expect, it } from 'vitest'
import { isIdentifierLike, isStrongIdentifier } from './identifiers'
import { markParameters } from './templates'

const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '')
const JWT = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'u-1', exp: 1900000000 })}.c2lnbmF0dXJl`

describe('isStrongIdentifier', () => {
  it('treats secrets in the path as parameters on sight', () => {
    expect(isStrongIdentifier(JWT)).toBe(true)
    expect(isStrongIdentifier('k3j4h5g6f7d8s9a0q1w2')).toBe(true)
    expect(isStrongIdentifier('secrettokenvalue_abcdefghijklmnop', 'reset')).toBe(true)
    expect(isStrongIdentifier('secrettokenvalue_abcdefghijklmnop')).toBe(false)
  })

  it('keeps the existing identifiers and leaves slugs literal', () => {
    expect(isStrongIdentifier('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isStrongIdentifier('123456')).toBe(true)
    expect(isStrongIdentifier('summer-sale-2026')).toBe(false)
    expect(isStrongIdentifier('iphone-15-pro-max-256gb')).toBe(false)
    expect(isStrongIdentifier('marketStatus')).toBe(false)
    expect(isIdentifierLike('summer-sale-2026')).toBe(true)
  })
})

describe('markParameters: tokens in paths', () => {
  it('makes a JWT and a token after /reset/ parameters from a single observation', () => {
    const marks = markParameters([
      `/api/magic/${JWT}`,
      '/api/reset/secrettokenvalue_abcdefghijklmnop',
      '/api/promo/summer-sale-2026',
    ], [])
    expect([
      ...(marks.get(`/api/magic/${JWT}`)?.keys() ?? []),
    ]).toEqual([2])
    expect([
      ...(marks.get('/api/reset/secrettokenvalue_abcdefghijklmnop')?.keys() ?? []),
    ]).toEqual([2])
    expect([
      ...(marks.get('/api/promo/summer-sale-2026')?.keys() ?? []),
    ]).toEqual([])
  })
})
