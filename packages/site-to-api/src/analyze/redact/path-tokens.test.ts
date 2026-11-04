import { describe, expect, it } from 'vitest'
import { isOpaquePathSegment, isRandomPathSegment, isSecretPathSegment, redactPathTokens } from './path-tokens'

const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '')
const JWT = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'u-1', exp: 1900000000 })}.c2lnbmF0dXJl`
/** Shopify-style global id: base64 of `gid://shopify/Product/1234567890`. */
const SHOPIFY_GID = btoa('gid://shopify/Product/1234567890').replace(/=+$/, '')
const OBJECT_ID = '5f2b8c1e9a7d4f3b2c1a0e9d'
const GIT_SHA = 'd670460b4b4aece5915caf5c68d12f560a9fe3e4'

/** Route names that follow credential words; none may become a token. */
const CREDENTIAL_WORD_SLUGS: ReadonlyArray<[string, string]> = [
  ['auth', 'registration-form'],
  ['auth', 'organization-settings'],
  ['auth', 'organization-members'],
  ['auth', 'password-requirements'],
  ['signin', 'organization-identifier'],
  ['confirm', 'subscription-preferences'],
  ['verify', 'international-shipping'],
  ['verify', 'internationalization'],
  ['reset', 'password-for-account'],
  ['confirm', 'Subscription-Preferences'],
  ['login', 'callback'],
  ['login', 'oauth2callback'],
  ['token', 'refresh'],
  ['verify', 'email'],
  ['reset', 'order-2026'],
  ['invite', 'pine-hill'],
]

describe('isSecretPathSegment', () => {
  it('recognises JWTs anywhere', () => {
    expect(isSecretPathSegment(JWT)).toBe(true)
    expect(isSecretPathSegment(encodeURIComponent(JWT), 'files')).toBe(true)
  })

  it('recognises a long segment right after a credential word', () => {
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop', 'reset')).toBe(true)
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop', 'verify-email')).toBe(true)
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop', 'token')).toBe(true)
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop', 'products')).toBe(false)
    expect(isSecretPathSegment('secrettokenvalue_abcdefghijklmnop')).toBe(false)
  })

  it('recognises padded, standard and percent-encoded base64 after a credential word', () => {
    for (const segment of [
      'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg%3D%3D',
      'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg==',
      'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg%3d%3d',
      'Xy7%2BQw9%2FZt3%3DLm2Pk8Rs',
      'Xy7+Qw9_Zt3-Lm2Pk8Rs',
      // 16+ characters after a credential word are a token whatever they contain.
      'abc%21def%40ghi%23jkl%24mno',
    ])
      expect(isSecretPathSegment(segment, 'reset'), segment).toBe(true)
  })

  it('recognises short and grouped one-time codes after a credential word', () => {
    expect(isSecretPathSegment('847263', 'reset')).toBe(true)
    expect(isSecretPathSegment('a1B2c3', 'verify')).toBe(true)
    expect(isSecretPathSegment('ABCD-EFGH-IJKL-MNOP', 'reset')).toBe(true)
    expect(isSecretPathSegment('7Q2X-9KDM', 'confirm')).toBe(true)
    expect(isSecretPathSegment('aBcDeF', 'magic')).toBe(true)
    // Not after a credential word, a code is just a value.
    expect(isSecretPathSegment('847263', 'orders')).toBe(false)
    expect(isSecretPathSegment('ABCD-EFGH-IJKL-MNOP')).toBe(false)
    // Too short to be a code.
    expect(isSecretPathSegment('12345', 'reset')).toBe(false)
  })

  it('keeps route names after credential words literal', () => {
    for (const [previous, segment] of CREDENTIAL_WORD_SLUGS)
      expect(isSecretPathSegment(segment, previous), `/${previous}/${segment}`).toBe(false)
  })

  it('reads a credential word only in a short route name, not inside a title slug (0065)', () => {
    // An article slug that happens to contain `code` or `login` says nothing about the id after it.
    expect(isSecretPathSegment('4413240', 'announcing-a-new-ide-for-postgresql-in-vs-code-from-microsoft')).toBe(false)
    expect(isSecretPathSegment('8472631', 'why-our-login-page-was-slow-for-a-week')).toBe(false)
    // Short credential routes still mark the code after them.
    expect(isSecretPathSegment('847263', 'verify-code')).toBe(true)
    expect(isSecretPathSegment('847263', 'email-verification-code')).toBe(true)
    expect(isSecretPathSegment('847263', 'reset-password-code-step')).toBe(true)
  })

  it('does not treat random ids with no credential word as secrets', () => {
    for (const segment of [
      'aB3dE5gH7jK9mN1pQ2xY',
      OBJECT_ID,
      GIT_SHA,
      SHOPIFY_GID,
      'iPhone15ProMax256GB',
    ])
      expect(isSecretPathSegment(segment, 'products'), segment).toBe(false)
  })
})

describe('isRandomPathSegment', () => {
  it('recognises random-looking ids, hashes and encoded ids on sight', () => {
    for (const segment of [
      JWT,
      'aB3dE5gH7jK9mN1pQ2xY',
      'k3j4h5g6f7d8s9a0q1w2',
      '5f2b8c1e9a7d4f3b',
      'd41d8cd98f00b204e9800998ecf8427e',
      'Zx9Qw8Er7Ty6Ui5Op4As',
      'prefix_aB3dE5gH7jK9mN1pQ2xY',
      OBJECT_ID,
      GIT_SHA,
      SHOPIFY_GID,
      'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg%3D%3D',
      'Xy7%2BQw9%2FZt3%3DLm2Pk8Rs',
      encodeURIComponent(JWT),
    ])
      expect(isRandomPathSegment(segment), segment).toBe(true)
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
      'registration-form',
      'organization-identifier',
      '',
    ])
      expect(isRandomPathSegment(segment), segment).toBe(false)
  })
})

describe('isOpaquePathSegment', () => {
  it('flags high-entropy random strings that may be unmarked credentials', () => {
    for (const segment of ['aB3dE5gH7jK9mN1pQ2xY', 'Zx9Qw8Er7Ty6Ui5Op4As', 'Xy7%2BQw9%2FZt3%3DLm2Pk8Rs'])
      expect(isOpaquePathSegment(segment), segment).toBe(true)
  })

  it('treats hex ids, encoded text, JWTs and words with numbers as public ids', () => {
    for (const segment of [
      OBJECT_ID,
      GIT_SHA,
      'd41d8cd98f00b204e9800998ecf8427e',
      SHOPIFY_GID,
      'iPhone15ProMax256GB',
      JWT,
      'summer-sale-2026',
    ])
      expect(isOpaquePathSegment(segment), segment).toBe(false)
  })
})

describe('redactPathTokens', () => {
  it('replaces secret and opaque segments with {token} and keeps the rest', () => {
    expect(redactPathTokens(`/magic/${JWT}`)).toBe('/magic/{token}')
    expect(redactPathTokens('/reset/secrettokenvalue_abcdefghijklmnop/confirm')).toBe('/reset/{token}/confirm')
    expect(redactPathTokens('/api/reset/dGhpcyBpcyBhIHNlY3JldCB0b2tlbg%3D%3D')).toBe('/api/reset/{token}')
    expect(redactPathTokens('/api/reset/Xy7%2BQw9%2FZt3%3DLm2Pk8Rs')).toBe('/api/reset/{token}')
    expect(redactPathTokens('/reset/847263')).toBe('/reset/{token}')
    expect(redactPathTokens('/files/aB3dE5gH7jK9mN1pQ2xY/view')).toBe('/files/{token}/view')
    expect(redactPathTokens(`/api/products/${OBJECT_ID}`)).toBe(`/api/products/${OBJECT_ID}`)
    expect(redactPathTokens('/auth/registration-form')).toBe('/auth/registration-form')
    expect(redactPathTokens('/promo/summer-sale-2026')).toBe('/promo/summer-sale-2026')
    expect(redactPathTokens('/')).toBe('/')
  })
})

describe('path segments joined by colons', () => {
  /** Shaped like a Cloudflare challenge segment: `<float>:<epoch>:<token>`, made-up values. */
  const CHALLENGE = '0.418273645509182:1700000000:Hq7ZpL2xVb9KmR4tWc8NyD3fJs6GaE1uYo5Tk0Xi'

  it('treats a random run between colons as an opaque token', () => {
    expect(isRandomPathSegment(CHALLENGE)).toBe(true)
    expect(isOpaquePathSegment(CHALLENGE)).toBe(true)
    expect(redactPathTokens(`/cdn-cgi/challenge-platform/h/g/jsd/oneshot/0a1b2c3d4e5f/${CHALLENGE}/9f8e7d6c5b4a3210`))
      .toBe('/cdn-cgi/challenge-platform/h/g/jsd/oneshot/0a1b2c3d4e5f/{token}/9f8e7d6c5b4a3210')
  })

  it('judges the token after the last colon whole, with - and _ in it', () => {
    const segment = '0.4182736455:1700000000:Hq7ZpL2x_Vb9KmR4tWc-8NyD3fJs6GaE1u'
    expect(isRandomPathSegment(segment)).toBe(true)
    expect(isOpaquePathSegment(segment)).toBe(true)
  })

  it('keeps words and times joined by colons', () => {
    expect(isRandomPathSegment('urn:isbn:0451450523')).toBe(false)
    expect(isRandomPathSegment('2026-10-28T12:30:00')).toBe(false)
    expect(isRandomPathSegment('spotify:track:playlist')).toBe(false)
  })
})
