import { describe, expect, it } from 'vitest'
import { isSecretPathSegment, redactPathTokens } from './path-tokens'

const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '')
const JWT = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'u-1', exp: 1900000000 })}.c2lnbmF0dXJl`

describe('isSecretPathSegment', () => {
  it('recognises JWTs, random-looking tokens and hashes on sight', () => {
    for (const segment of [
      JWT,
      'aB3dE5gH7jK9mN1pQ2xY',
      'k3j4h5g6f7d8s9a0q1w2',
      '5f2b8c1e9a7d4f3b',
      'd41d8cd98f00b204e9800998ecf8427e',
      'Zx9Qw8Er7Ty6Ui5Op4As',
      'prefix_aB3dE5gH7jK9mN1pQ2xY',
      encodeURIComponent(JWT),
    ])
      expect(isSecretPathSegment(segment), segment).toBe(true)
  })

  it('recognises a long segment right after a credential word', () => {
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop', 'reset')).toBe(true)
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop', 'verify-email')).toBe(true)
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop', 'token')).toBe(true)
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop', 'products')).toBe(false)
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop')).toBe(false)
    // Short words after `reset` are a route, not a token.
    expect(isSecretPathSegment('password-for-account', 'reset')).toBe(false)
  })

  it('leaves slugs, route names, versions and short ids alone', () => {
    for (const segment of [
      'summer-sale-2026',
      'iphone-15-pro-max-256gb',
      'all-upcoming-issues-this-month',
      'getAllUpcomingIssues',
      'GetMarketStatusForToday',
      'internationalization',
      'marketStatus',
      'NIFTY_50',
      'RELIANCE',
      'v1',
      'ITM-7731-XQ',
      '1700000000000',
      'deadbeefdeadbeef',
      'order_2026_10_28_summary',
      'pine-hill',
      '',
    ])
      expect(isSecretPathSegment(segment), segment).toBe(false)
  })
})

describe('redactPathTokens', () => {
  it('replaces token segments with {token} and keeps the rest', () => {
    expect(redactPathTokens(`/magic/${JWT}`)).toBe('/magic/{token}')
    expect(redactPathTokens('/reset/secrettokenvalue_abcdefghijklmnop/confirm')).toBe('/reset/{token}/confirm')
    expect(redactPathTokens('/promo/summer-sale-2026')).toBe('/promo/summer-sale-2026')
    expect(redactPathTokens('/')).toBe('/')
  })
})
