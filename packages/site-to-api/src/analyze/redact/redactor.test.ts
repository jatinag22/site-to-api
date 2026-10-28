import type { ResolvedConfig } from '../../config/schema'
import type { Exchange, RedactContext, Redactor } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody } from '../../../test/helpers'
import { CONFIG, fixtureExchanges, SECRETS } from '../../../test/secret-fixture'
import { SiteToApiError } from '../../errors'
import { isLuhnValid, isVerhoeffValid, maskPersonalData, PERSONAL_DATA_PATTERNS } from './personal-data'
import { createRedactor } from './redactor'
import { isSecretName } from './secret-names'

function redactor(exchanges: Exchange[], config: Partial<ResolvedConfig['redact']> = {}): Redactor {
  return createRedactor({
    exchanges,
    config: {
      ...CONFIG,
      ...config,
    },
  })
}

/** Every value of an exchange passed through the redactor, the way emitters would. */
function redactEverything(r: Redactor, item: Exchange): unknown[] {
  const out: unknown[] = [
    r.value(item.request.url, { in: 'text' }),
  ]
  const pairs = (list: Array<{ name: string, value: string }>, where: RedactContext['in']): void => {
    for (const pair of list) out.push(r.value(pair.value, { in: where, name: pair.name }))
  }
  pairs(item.request.query, 'query')
  pairs(item.request.headers, 'header')
  pairs(item.request.cookies, 'cookie')
  pairs(item.response.setCookies, 'set-cookie')
  pairs(item.response.headers, 'response-header')
  for (const [where, body] of [
    ['body', item.request.body],
    ['response-body', item.response.body],
  ] as const) {
    if (!body)
      continue
    if (body.form)
      pairs(body.form, 'form')
    if (body.json !== undefined)
      out.push(r.json(body.json, { in: where }), r.examples([body.json], { in: where }))
    if (body.text !== null)
      out.push(r.value(body.text, { in: where }))
  }
  return out
}

function leakedSecrets(text: string): string[] {
  const needles = Object.values(SECRETS).flatMap((secret) => {
    const value = String(secret)
    return [
      value,
      encodeURIComponent(value),
      value.replace(/\D/g, '').length >= 10
        ? value.replace(/\D/g, '')
        : value,
    ]
  })
  needles.push('9876543210', 'jane.doe')
  return [
    ...new Set(needles),
  ].filter(needle => text.includes(needle))
}

describe('createRedactor: no fixture secret survives', () => {
  it('in masked mode, across every location of every exchange', () => {
    const exchanges = fixtureExchanges()
    const r = redactor(exchanges)
    const output = JSON.stringify(exchanges.flatMap(item => redactEverything(r, item)))
    expect(leakedSecrets(output)).toEqual([])
    // Constants and ordinary data stay readable; a person's name next to their email does not.
    expect(output).toContain('1.2.3')
    expect(output).toContain('lang=en')
    expect(output).not.toContain('Jane')
  })
})

describe('createRedactor: rules', () => {
  const exchanges = fixtureExchanges()
  const r = redactor(exchanges)

  it('replaces cookies, credential headers and JWTs by a shape description', () => {
    expect(r.value(SECRETS.sessionCookie, { in: 'cookie', name: 'session' })).toBe('<redacted: 25 base64 chars>')
    expect(r.value('dark', { in: 'cookie', name: 'theme' })).toBe('<redacted: 4 chars>')
    expect(r.value(`Bearer ${SECRETS.bearer}`, { in: 'header', name: 'Authorization' })).toMatch(/^<redacted: /)
    expect(r.value(SECRETS.jwt, { in: 'body', name: 'anything' })).toBe('<redacted: JWT (alg=HS256, claims=[exp, sub])>')
  })

  it('redacts configured fields case-insensitively', () => {
    expect(r.value('x', { in: 'header', name: 'x-device' })).toBe('<redacted: 1 chars>')
    expect(r.json({ 'X-DEVICE': 'abc' }, { in: 'body' })).toEqual({ 'X-DEVICE': '<redacted: 3 hex chars>' })
  })

  it('keeps secret-named values that are constant across sessions, but never JWTs or cookies', () => {
    const jwt = SECRETS.jwt
    const list = ['s1', 's2'].map(sessionId => exchange({
      sessionId,
      url: 'https://shop.test/api/a',
      requestHeaders: { 'x-api-key': 'public-key-123456', 'x-jwt': jwt, 'x-csrf': `csrf-${sessionId}-value` },
      cookies: { consent: 'yes-all' },
    }))
    const r2 = redactor(list)
    expect(r2.value('public-key-123456', { in: 'header', name: 'x-api-key' })).toBe('public-key-123456')
    expect(r2.value(jwt, { in: 'header', name: 'x-jwt' })).toMatch(/^<redacted: JWT/)
    expect(r2.value('csrf-s1-value', { in: 'header', name: 'x-csrf' })).toMatch(/^<redacted/)
    expect(r2.value('yes-all', { in: 'cookie', name: 'consent' })).toMatch(/^<redacted/)
  })

  it('with a single session nothing counts as constant', () => {
    const single = redactor([
      exchange({
        url: 'https://shop.test/a',
        requestHeaders: { 'x-api-key': 'public-key-123456' },
      }),
    ])
    expect(single.value('public-key-123456', { in: 'header', name: 'x-api-key' })).toMatch(/^<redacted/)
  })

  it('masks personal data keeping its format', () => {
    expect(r.value(SECRETS.email, { in: 'body' })).toBe('xxxx.xxx@xxxx.xxxx')
    expect(r.value(SECRETS.pan, { in: 'body' })).toBe('XXXXX0000X')
    expect(r.value(SECRETS.aadhaar, { in: 'body' })).toBe('0000 0000 0000')
    expect(r.value(SECRETS.card, { in: 'body' })).toBe('0000 0000 0000 0000')
    expect(r.value(SECRETS.phone, { in: 'body' })).toBe('+00 00000 00000')
    expect(r.value('9876543210', { in: 'body', name: 'mobileNumber' })).toBe('0000000000')
    expect(r.json({ aadhaar: SECRETS.aadhaarNumber }, { in: 'body' })).toEqual({ aadhaar: '000000000000' })
    expect(r.value('ID EMP-123456 here', { in: 'body' })).toBe('ID XXX-000000 here')
  })

  it('masks personal and account fields by name, keeping their format', () => {
    // The shapes of a shop's `GET /api/me` and login responses.
    const me = {
      id: 'usr_demo_0001',
      username: 'demo',
      displayName: 'Demo Shopper',
      email: 'demo@shop.example',
    }
    expect(r.json(me, { in: 'response-body' })).toEqual({
      id: 'xxx_xxxx_0000',
      username: 'xxxx',
      displayName: 'Xxxx Xxxxxxx',
      email: 'xxxx@xxxx.xxxxxxx',
    })
    const login = {
      token: SECRETS.jwt,
      tokenType: 'Bearer',
      expiresIn: 3600,
      user: me,
    }
    expect(r.json(login, { in: 'response-body' })).toEqual({
      token: '<redacted: JWT (alg=HS256, claims=[exp, sub])>',
      tokenType: 'Bearer',
      expiresIn: 3600,
      user: {
        id: 'xxx_xxxx_0000',
        username: 'xxxx',
        displayName: 'Xxxx Xxxxxxx',
        email: 'xxxx@xxxx.xxxxxxx',
      },
    })
    // Under a user, account, profile or customer name, `name` and `id` identify the person too.
    expect(r.json({
      customer: { id: 42, name: 'Asha Rao' },
      profiles: [
        { name: 'Dev' },
      ],
    }, { in: 'response-body' }))
      .toEqual({
        customer: { id: '00', name: 'Xxxx Xxx' },
        profiles: [
          { name: 'Xxx' },
        ],
      })
    expect(r.json({
      orders: [
        { userId: 'usr_demo_0001', total: 5 },
      ],
    }, { in: 'response-body' }))
      .toEqual({
        orders: [
          { userId: 'xxx_xxxx_0000', total: 5 },
        ],
      })
    const address = {
      firstName: 'Asha',
      last_name: 'Rao',
      fullName: 'Asha Rao',
      user_name: 'asha',
      login: 'asha',
      street: '12 Pine Road',
      city: 'Pune',
      postcode: 'AB1 2CD',
      zip: 411001,
      dob: '1990-01-31',
      birthDate: '1990-01-31',
      billingAddress: '12 Pine Road',
    }
    expect(r.json(address, { in: 'body' })).toEqual({
      firstName: 'Xxxx',
      last_name: 'Xxx',
      fullName: 'Xxxx Xxx',
      user_name: 'xxxx',
      login: 'xxxx',
      street: '00 Xxxx Xxxx',
      city: 'Xxxx',
      postcode: 'XX0 0XX',
      zip: '000000',
      dob: '0000-00-00',
      birthDate: '0000-00-00',
      billingAddress: '00 Xxxx Xxxx',
    })
    // Single values by name, as in forms and flows.
    expect(r.value('demo', { in: 'body', name: 'username' })).toBe('xxxx')
    expect(r.value('demo', { in: 'form', name: 'login' })).toBe('xxxx')
  })

  it('keeps ordinary names and ids outside person records', () => {
    expect(r.json([
      { id: 7, name: 'Snacks', slug: 'snacks' },
    ], { in: 'response-body' })).toEqual([
      { id: 7, name: 'Snacks', slug: 'snacks' },
    ])
    // A store list has a city but is not a person; only the address fields are masked.
    expect(r.json({
      stores: [
        { name: 'Pine Hill', city: 'Pune' },
      ],
    }, { in: 'response-body' })).toEqual({
      stores: [
        { name: 'Pine Hill', city: 'Xxxx' },
      ],
    })
    expect(r.json({ velocity: 'fast', lastLogin: '2026-10-28' }, { in: 'response-body' })).toEqual({ velocity: 'fast', lastLogin: '2026-10-28' })
  })

  it('keeps auth scheme words under secret names, and does not hunt for them elsewhere', () => {
    const list = [
      exchange({
        url: 'https://shop.test/api/login',
        responseBody: jsonBody({ tokenType: 'Bearer', note: 'Send it as Bearer in the header' }),
      }),
    ]
    const r2 = redactor(list)
    for (const scheme of [
      'Bearer',
      'Basic',
      'Token',
      'JWT',
      'MAC',
      'Digest',
      'Negotiate',
      'bearer',
    ])
      expect(r2.value(scheme, { in: 'response-body', name: 'tokenType' })).toBe(scheme)
    expect(r2.json({ tokenType: 'Bearer', note: 'Send it as Bearer in the header' }, { in: 'response-body' }))
      .toEqual({ tokenType: 'Bearer', note: 'Send it as Bearer in the header' })
    // Anything else under a secret name is still redacted, and the scheme inside a credential header too.
    expect(r2.value('Bearer2', { in: 'response-body', name: 'tokenType' })).toBe('<redacted: 7 chars>')
    expect(r2.value('Bearer', { in: 'header', name: 'authorization' })).toBe('<redacted: 6 chars>')
  })

  it('leaves look-alikes alone: timestamps, failed checksums, plain numbers', () => {
    expect(r.value('1700000000000', { in: 'body' })).toBe('1700000000000')
    expect(r.value('234567890123', { in: 'body' })).toBe('234567890123')
    expect(r.value('4111 1111 1111 1112', { in: 'body' })).toBe('4111 1111 1111 1112')
    expect(r.json({
      count: 42,
      price: 99.5,
      ok: true,
      none: null,
    }, { in: 'body' })).toEqual({
      count: 42,
      price: 99.5,
      ok: true,
      none: null,
    })
  })

  it('handles values inside JSON strings, URLs and URL-encoded text', () => {
    expect(r.value(JSON.stringify({ accessToken: 'abc-secret-1' }), { in: 'body' })).toBe('{"accessToken":"<redacted: 12 chars>"}')
    expect(r.value('https://shop.test/cb?code=abc&state=ok#x', { in: 'text' })).toBe('https://shop.test/cb?code=<redacted: 3 hex chars>&state=ok#x')
    expect(r.json({ code: 'IN' }, { in: 'body' })).toEqual({ code: 'IN' })
    expect(r.value('https://shop.test/cb?token=abc&state=ok', { in: 'text' })).toBe('https://shop.test/cb?token=<redacted: 3 hex chars>&state=ok')
    expect(r.value('a=1&password=xyz', { in: 'body' })).toBe('a=1&password=<redacted: 3 chars>')
    expect(r.value('user%3Djane.doe%40mail.test', { in: 'body' })).toBe('user=xxxx.xxx@xxxx.xxxx')
  })

  it('treats token path segments as secrets, here and wherever they are echoed', () => {
    const token = 'secrettokenvalue_abcdefghijklmnop'
    const r2 = redactor(['s1', 's2'].map(sessionId => exchange({ sessionId, url: `https://shop.test/api/reset/${token}` })))
    expect(r2.value(token, { in: 'path', name: 'resetId' })).toBe('<redacted: 33 base64 chars>')
    expect(r2.value(`https://shop.test/api/reset/${token}`, { in: 'text' })).toBe('https://shop.test/api/reset/<redacted: 33 base64 chars>')
    expect(r2.examples([token], { in: 'path', name: 'resetId' })).toEqual(['<redacted: 33 base64 chars>'])
    // Random-looking segments are recognised even when the capture never had them.
    expect(r2.value('aB3dE5gH7jK9mN1pQ2xY', { in: 'path', name: 'fileId' })).toBe('<redacted: 20 base64 chars>')
    expect(r2.value('summer-sale-2026', { in: 'path', name: 'slug' })).toBe('summer-sale-2026')
  })

  it('learns base64 tokens with padding, `+` and `/` after a credential word, in every encoding', () => {
    const padded = 'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg=='
    const standard = 'Xy7+Qw9/Zt3=Lm2Pk8Rs'
    const r2 = redactor(['s1', 's2'].flatMap(sessionId => [
      exchange({ sessionId, url: `https://shop.test/api/reset/${encodeURIComponent(padded)}` }),
      exchange({ sessionId, url: `https://shop.test/api/reset/${encodeURIComponent(standard)}` }),
      exchange({ sessionId, url: 'https://shop.test/api/reset/dGhpcyBpcyBhIHNlY3JldCB0b2tlbg%3d%3d' }),
    ]))
    for (const text of [
      padded,
      encodeURIComponent(padded),
      'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg%3d%3d',
      standard,
      encodeURIComponent(standard),
    ]) {
      expect(r2.value(`see https://shop.test/api/reset/${text} now`, { in: 'response-body' }), text).not.toContain(text)
      expect(r2.value(text, { in: 'path', name: 'resetId' }), text).toMatch(/^<redacted/)
    }
  })

  it('learns short one-time codes after a credential word', () => {
    const r2 = redactor(['s1', 's2'].map(sessionId => exchange({ sessionId, url: 'https://shop.test/reset/847263' })))
    expect(r2.value('Your code is 847263.', { in: 'response-body' })).toBe('Your code is <redacted: 6-digit number>.')
  })

  it('keeps route names after credential words readable in every response', () => {
    const slugs = [
      'registration-form',
      'organization-settings',
      'password-requirements',
      'organization-identifier',
      'subscription-preferences',
      'international-shipping',
    ]
    const r2 = redactor(['auth', 'signin', 'confirm', 'verify'].flatMap(word => slugs.map(slug => exchange({ url: `https://shop.test/${word}/${slug}` }))))
    for (const slug of slugs) {
      expect(r2.value(`Complete your ${slug} today`, { in: 'response-body' })).toBe(`Complete your ${slug} today`)
      expect(r2.value(slug, { in: 'path', name: 'page' })).toBe(slug)
    }
  })

  it('keeps public random ids from paths (hex, encoded ids, words with numbers) like UUIDs', () => {
    const gid = btoa('gid://shopify/Product/1234567890')
    const ids = [
      '5f2b8c1e9a7d4f3b2c1a0e9d',
      'd670460b4b4aece5915caf5c68d12f560a9fe3e4',
      gid,
      'iPhone15ProMax256GB',
    ]
    const r2 = redactor(ids.map(id => exchange({
      url: `https://shop.test/api/products/${encodeURIComponent(id)}`,
      responseBody: jsonBody({ id, name: 'Lamp' }),
    })))
    for (const id of ids) {
      expect(r2.json({ id }, { in: 'response-body' })).toEqual({ id })
      expect(r2.value(`https://shop.test/api/products/${id}`, { in: 'text' })).toBe(`https://shop.test/api/products/${id}`)
      expect(r2.value(id, { in: 'path', name: 'productId' })).toBe(id)
    }
  })

  it('treats opaque random path segments as secret unless identical in every session', () => {
    const perSession = redactor([
      exchange({ sessionId: 's1', url: 'https://shop.test/files/aB3dE5gH7jK9mN1pQ2xY' }),
      exchange({ sessionId: 's2', url: 'https://shop.test/files/Zx9Qw8Er7Ty6Ui5Op4As' }),
    ])
    expect(perSession.value('link: /files/aB3dE5gH7jK9mN1pQ2xY', { in: 'response-body' })).toBe('link: /files/<redacted: 20 base64 chars>')
    const shared = redactor(['s1', 's2'].map(sessionId => exchange({ sessionId, url: 'https://shop.test/files/aB3dE5gH7jK9mN1pQ2xY' })))
    expect(shared.value('aB3dE5gH7jK9mN1pQ2xY', { in: 'path', name: 'fileId' })).toBe('aB3dE5gH7jK9mN1pQ2xY')
  })

  it('removes known secrets wherever they are echoed', () => {
    expect(r.value(`echo ${SECRETS.sessionCookie} end`, { in: 'response-body' })).toBe('echo <redacted: 25 base64 chars> end')
    expect(r.value(SECRETS.setCookie, { in: 'body', name: 'value' })).toMatch(/^<redacted/)
  })
})

describe('createRedactor: modes and examples', () => {
  const exchanges = fixtureExchanges()

  it('raw mode returns captured values unchanged', () => {
    const r = redactor(exchanges, { examples: 'raw' })
    expect(r.value(SECRETS.sessionCookie, { in: 'cookie', name: 'session' })).toBe(SECRETS.sessionCookie)
    const body = { email: SECRETS.email }
    expect(r.json(body, { in: 'body' })).toEqual(body)
    expect(r.examples(['a', 'a', 'b'], { in: 'query' })).toEqual(['a', 'b'])
  })

  it('none mode writes no examples, but still redacts values', () => {
    const r = redactor(exchanges, { examples: 'none' })
    expect(r.examples(['a'], { in: 'query' })).toEqual([])
    expect(r.value(SECRETS.email, { in: 'body' })).toBe('xxxx.xxx@xxxx.xxxx')
  })

  it('examples are redacted, de-duplicated after redaction and capped', () => {
    const r = redactor(exchanges, { maxExamples: 2 })
    expect(r.examples(['a@b.test', 'c@d.test', 'one', 'two'], { in: 'query', name: 'q' })).toEqual(['x@x.xxxx', 'one'])
    expect(r.examples([
      { token: 'abcdef1' },
    ], { in: 'body' })).toEqual([
      { token: '<redacted: 7 hex chars>' },
    ])
    expect(redactor(exchanges, { maxExamples: 0 }).examples(['a'], { in: 'query' })).toEqual([])
  })

  it('rejects invalid configured patterns with an actionable error', () => {
    expect(() => redactor(exchanges, {
      patterns: [
        { name: 'bad', regex: '(' },
      ],
    })).toThrow(SiteToApiError)
  })

  it('is deterministic', () => {
    const body = jsonBody({ token: SECRETS.jwt }).json
    expect(redactor(fixtureExchanges()).json(body, { in: 'body' })).toEqual(redactor(fixtureExchanges()).json(body, { in: 'body' }))
  })
})

describe('checksums and names', () => {
  it('validates Luhn and Verhoeff', () => {
    expect(isLuhnValid('4111111111111111')).toBe(true)
    expect(isLuhnValid('4111111111111112')).toBe(false)
    expect(isVerhoeffValid('234567890124')).toBe(true)
    expect(isVerhoeffValid('234567890123')).toBe(false)
  })

  it('masks every match in free text', () => {
    expect(maskPersonalData('a@b.co and c@d.co', PERSONAL_DATA_PATTERNS)).toBe('x@x.xx and x@x.xx')
  })

  it('recognises secret names by word', () => {
    for (const name of [
      'authorization',
      'x-csrf-token',
      'accessToken',
      'session_id',
      'apiKey',
      'x-api-key',
      'password',
      'csrfmiddlewaretoken',
      'PHPSESSID',
    ])
      expect(isSecretName(name), name).toBe(name !== 'PHPSESSID')
    for (const name of [
      'author',
      'pincode',
      'tokenizer_mode',
      'keyword',
      null,
    ])
      expect(isSecretName(name), String(name)).toBe(false)
  })
})
