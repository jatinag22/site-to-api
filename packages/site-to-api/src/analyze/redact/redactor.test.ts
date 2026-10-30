import type { ResolvedConfig } from '../../config/schema'
import type { Exchange, RedactContext, Redactor } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody, textBody } from '../../../test/helpers'
import { CONFIG, fixtureExchanges, SECRETS } from '../../../test/secret-fixture'
import { SiteToApiError } from '../../errors'
import { isLuhnValid, isTrackingIdName, isVerhoeffValid, maskPersonalData, PERSONAL_DATA_PATTERNS } from './personal-data'
import { createRedactor } from './redactor'
import { isPublishableKeyName, isSecretName } from './secret-names'

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

  it('always redacts credential inputs, even when identical in every session', () => {
    const typed = 'Same-Pa55word-twice'
    const list = ['s1', 's2'].map(sessionId => exchange({
      sessionId,
      method: 'POST',
      url: `https://shop.test/api/login?pwd=${encodeURIComponent(typed)}`,
      requestHeaders: { 'x-api-key': 'public-key-123456', 'x-otp': '482916' },
      requestBody: jsonBody({
        password: typed,
        pin: '4829',
        client_secret: 'cs-0123456789',
        refresh_token: 'rt-0123456789',
        sessionId: 'sid-0123456789',
        mfa_code: '777001',
      }),
    }))
    const r2 = redactor(list)
    expect(r2.value(typed, { in: 'query', name: 'pwd' })).toMatch(/^<redacted/)
    expect(r2.value(typed, { in: 'form', name: 'password' })).toMatch(/^<redacted/)
    expect(r2.value('482916', { in: 'header', name: 'x-otp' })).toMatch(/^<redacted/)
    expect(r2.json(list[0]!.request.body?.json, { in: 'body' })).toEqual({
      password: '<redacted: 19 base64 chars>',
      pin: '<redacted: 4-digit number>',
      client_secret: '<redacted: 13 chars>',
      refresh_token: '<redacted: 13 chars>',
      sessionId: '<redacted: 14 chars>',
      mfa_code: '<redacted: 6-digit number>',
    })
    // Scrubbed wherever it is echoed, too.
    expect(r2.value(`echo ${typed} back`, { in: 'response-body' })).not.toContain(typed)
    // The publishable key stays a constant.
    expect(r2.value('public-key-123456', { in: 'header', name: 'x-api-key' })).toBe('public-key-123456')
  })

  it('tells publishable key names from credential names', () => {
    for (const name of [
      'x-api-key',
      'apiKey',
      'api_key',
      'publishableKey',
      'stripe-publishable-key',
      'siteKey',
      'recaptcha_site_key',
      'clientId',
      'appId',
    ])
      expect(isPublishableKeyName(name), name).toBe(true)
    expect(isPublishableKeyName('key', true)).toBe(true)
    expect(isPublishableKeyName('key')).toBe(false)
    for (const name of [
      'password',
      'pwd',
      'pin',
      'otp',
      'apiKeySecret',
      'api_secret_key',
      'private_key',
      'privateKey',
      'client_secret',
      'access_token',
      'refresh_token',
      'sessionId',
      'x-csrf-token',
      'apiToken',
      'mfa_code',
    ])
      expect(isPublishableKeyName(name), name).toBe(false)
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

  it('masks the person\'s IP address fields, as YouTube echoes it in every request body', () => {
    expect(r.json({
      context: {
        client: { remoteHost: '203.0.113.94', clientName: 'WEB' },
      },
      client_ip: '198.51.100.7',
      zip: 'x',
    }, { in: 'body' })).toEqual({
      context: {
        client: { remoteHost: '000.0.000.00', clientName: 'WEB' },
      },
      client_ip: '000.00.000.0',
      zip: 'x',
    })
  })

  it('masks public IPv4 addresses anywhere, but not versions, networks or private addresses', () => {
    expect(r.json([
      ['en-GB', 'IN', null, '203.0.113.94'],
    ], { in: 'response-body' })).toEqual([
      ['en-GB', 'IN', null, '000.0.000.00'],
    ])
    expect(r.value('Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36', { in: 'header', name: 'user-agent' })).toBe('Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36')
    expect(r.value('v1.2.3.4', { in: 'body' })).toBe('v1.2.3.4')
    expect(r.value('2.20261029.00.00', { in: 'body' })).toBe('2.20261029.00.00')
    expect(r.value('10.0.0.5 and 192.168.1.20 and 172.16.4.4', { in: 'body' })).toBe('10.0.0.5 and 192.168.1.20 and 172.16.4.4')
    expect(r.value('from 8.8.8.8, via 1.1.1.1.', { in: 'body' })).toBe('from 0.0.0.0, via 0.0.0.0.')

    // Four-part versions named as such stay; addresses named as such are masked.
    expect(r.value('version 1.2.3.4', { in: 'body' })).toBe('version 1.2.3.4')
    expect(r.value('app?ver=4.1.2.3&x=1', { in: 'body' })).toBe('app?ver=4.1.2.3&x=1')
    expect(r.value('Version: 81.2.69.161', { in: 'body' })).toBe('Version: 81.2.69.161')
    expect(r.value('ip=81.2.69.160', { in: 'body' })).toBe('ip=00.0.00.000')
    expect(r.value('host 81.2.69.160:8080', { in: 'body' })).toBe('host 00.0.00.000:8080')
  })

  it('masks public IPv6 addresses in free text, but not times, MAC addresses, hex ids or local addresses', () => {
    expect(r.value('client 2a00:1450:4009:81f::200e connected', { in: 'body' })).toBe('client 0x00:0000:0000:00x::000x connected')
    expect(r.value('[2001:4860:4860::8888]:443', { in: 'body' })).toBe('[0000:0000:0000::0000]:443')
    expect(r.json({ addr: '2604:a880:400:d0::1b4:6001' }, { in: 'response-body' })).toEqual({ addr: '0000:x000:000:x0::0x0:0000' })
    const kept = [
      'at 12:30:45 and 23:59:59',
      'mac aa:bb:cc:dd:ee:ff',
      'id 2024abcdef1234567890',
      'loopback ::1 and fe80::1 and fd00::5',
      'docs 2001:db8::1',
      'date 2026:10:30',
      'std::vector<int>',
    ]
    for (const text of kept)
      expect(r.value(text, { in: 'body' })).toBe(text)
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

  it('masks other players in a game feed: ids, names and profile pictures', () => {
    const feed = {
      cashouts: [
        {
          player_id: '40001&&demo',
          username: 'demo_90001',
          profileImage: 'av-1.png',
          avatarUrl: 'https://cdn.example/a/40001.png',
          multiplier: 1.5,
        },
      ],
      topPlayerProfileImages: ['av-3.png'],
      openBetsCount: 12,
    }
    const masked = JSON.stringify(r.json(feed, { in: 'response-body' }))
    for (const value of [
      '40001',
      'demo_90001',
      'av-1.png',
      'av-3.png',
    ])
      expect(masked).not.toContain(value)
    expect(masked).toContain('"multiplier":1.5')
    expect(masked).toContain('"openBetsCount":12')
  })

  it('masks user agents and device descriptions in bodies, not the User-Agent header', () => {
    const agent = 'Mozilla/5.0 (Plan9; Glenda) Fakekit/999.1 Exampler/42.0'
    const body = {
      platform: {
        userAgent: agent,
        deviceInfo: JSON.stringify({ userAgent: agent, os: 'Plan9' }),
        deviceType: 'desktop',
      },
      ua: agent,
    }
    const masked = JSON.stringify(r.json(body, { in: 'body' }))
    for (const value of [
      'Plan9',
      'Glenda',
      'Fakekit',
      'Exampler',
    ])
      expect(masked).not.toContain(value)
    expect(masked).toContain('"deviceType":"desktop"')
    expect(r.value(agent, { in: 'header', name: 'user-agent' })).toBe(agent)
  })

  it('redacts values a protocol names as secrets, whatever their field name or length', () => {
    const known = createRedactor({
      exchanges: [],
      config: CONFIG,
      knownSecrets: ['bob', 'hunter2-hunter2', ''],
    })
    expect(known.json({ un: 'bob', pw: 'hunter2-hunter2', zn: 'zone' }, { in: 'body' })).toEqual({
      un: expect.stringMatching(/^<redacted/) as unknown,
      pw: expect.stringMatching(/^<redacted/) as unknown,
      zn: 'zone',
    })
    // Long ones are also found inside other text.
    expect(known.text('echo hunter2-hunter2 back')).not.toContain('hunter2-hunter2')
    expect(known.value('', { in: 'body', name: 'pw' })).toBe('')
  })

  it('matches a numeric known secret in numbers only with 6 digits or more', () => {
    const known = createRedactor({
      exchanges: [],
      config: CONFIG,
      knownSecrets: ['1000', '123456'],
    })
    expect(known.json({ tables: 1000, id: 123_456 }, { in: 'response-body' })).toEqual({
      tables: 1000,
      id: expect.stringMatching(/^<redacted/) as unknown,
    })
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

describe('createRedactor: bot protection', () => {
  const answer = '{"workTime":1700000000000,"id":"c0ffee00c0ffee00c0ffee00c0ffee00","answers":[3,7]}'

  it('redacts bot-protection headers on ordinary calls, even when constant', () => {
    const items = ['s1', 's2'].map(sessionId => exchange({
      url: 'https://shop.test/api/cart',
      sessionId,
      requestHeaders: { 'x-kpsdk-cd': answer, 'x-kpsdk-v': 'j-1.2.3', 'x-aws-waf-token': 'Zm9vYmFyYmF6cXV4' },
      responseHeaders: { 'x-kpsdk-cr': 'true' },
    }))
    const r = redactor(items)
    expect(r.value(answer, { in: 'header', name: 'x-kpsdk-cd' })).toMatch(/^<redacted: /)
    expect(r.value('j-1.2.3', { in: 'header', name: 'X-Kpsdk-V' })).toMatch(/^<redacted: /)
    expect(r.value('Zm9vYmFyYmF6cXV4', { in: 'header', name: 'x-aws-waf-token' })).toMatch(/^<redacted: /)
    expect(r.value('true', { in: 'response-header', name: 'x-kpsdk-cr' })).toMatch(/^<redacted: /)
    // The answer is learnt as a secret, so an echo elsewhere is scrubbed too.
    expect(r.value(`echo ${answer}`, { in: 'text' })).not.toContain('c0ffee00')
    expect(r.value('v-2.0.0', { in: 'header', name: 'x-app-version' })).toBe('v-2.0.0')
  })

  it('masks every value of a browser-only step by its shape, keeping the structure', () => {
    const r = redactor([])
    const challenge = {
      challenge: { input: 'eyJ2ZXJzaW9uIjoxfQ', hmac: 'a1b2c3d4e5f6a7b8' },
      difficulty: 4,
      region: 'eu-west-1',
      ok: true,
      none: null,
      empty: '',
    }
    expect(r.browserOnly.json(challenge, { in: 'response-body' })).toEqual({
      challenge: { input: '<redacted: 18 base64 chars>', hmac: '<redacted: 16 hex chars>' },
      difficulty: '<redacted: 1-digit number>',
      region: '<redacted: 9 chars>',
      ok: true,
      none: null,
      empty: '',
    })
    expect(r.browserOnly.value('solution', { in: 'form', name: 'solution_data' })).toBe('<redacted: 8 chars>')
    expect(r.browserOnly.examples(['x', 'y', 'z'], { in: 'query' })).toEqual(['<redacted: 1 chars>'])
    expect(redactor([], { examples: 'none' }).browserOnly.examples(['a'], { in: 'query' })).toEqual([])
    expect(redactor([], { examples: 'raw' }).browserOnly.value('solution', { in: 'form' })).toBe('solution')
  })
})

describe('createRedactor: captcha and challenge tokens', () => {
  it('redacts captcha answers and Cloudflare challenge tokens, constant or not', () => {
    const turnstile = '0.Hq7ZpL2xVb9KmR4tWc8NyD3fJs6GaE1uYo5Tk0Xi.d62306d4ee00c77dda697f959ebbd7bd'
    const items = ['s1', 's2'].map(sessionId => exchange({
      method: 'POST',
      url: 'https://shop.test/questions?__cf_chl_tk=Zq8Wm3Np5Rt7Vx9Bc2Df-1700000000-0-gaNycGzNCuU',
      sessionId,
      requestBody: jsonBody({ 'cf-turnstile-response': turnstile, 'g-recaptcha-response': 'r3c4ptch4-answer', 'h-captcha-response': 'hc4ptch4-answer' }),
    }))
    const r = redactor(items)
    expect(r.value(turnstile, { in: 'form', name: 'cf-turnstile-response' })).toMatch(/^<redacted: /)
    expect(r.value('r3c4ptch4-answer', { in: 'body', name: 'g-recaptcha-response' })).toMatch(/^<redacted: /)
    expect(r.value('hc4ptch4-answer', { in: 'body', name: 'h-captcha-response' })).toMatch(/^<redacted: /)
    for (const name of ['__cf_chl_tk', '__cf_chl_rt_tk', '__cf_chl_f_tk'])
      expect(r.value('Zq8Wm3Np5Rt7Vx9Bc2Df-1700000000-0-gaNycGzNCuU', { in: 'query', name })).toMatch(/^<redacted: /)
    expect(r.value(`echo ${turnstile}`, { in: 'text' })).not.toContain('Hq7ZpL2x')
  })
})

describe('createRedactor: free text and percent-encoding', () => {
  const withCookie = (value: string): Redactor => redactor([
    exchange({
      url: 'https://shop.test/api/x',
      cookies: { sid: value },
    }),
  ])

  it('scrubs a percent-encoded cookie from text that also holds other %xx sequences', () => {
    const cookie = 'AbC123xYz%2BqWe%3D'
    const text = `// excerpt\nconst q = "a%20b";\nconst t = "${cookie}";\n`
    for (const out of [
      withCookie(cookie).value(text, { in: 'text' }),
      withCookie(cookie).text(text),
    ]) {
      expect(out).not.toContain(cookie)
      expect(out).not.toContain('AbC123xYz+qWe=')
      expect(out).toContain('const q = "a%20b";')
    }
  })

  it('scrubs a cookie with + and / beside unrelated %20, and the decoded form of an encoded one', () => {
    const plus = 'AbC123+xYz/qWeRtY='
    expect(withCookie(plus).value(`const q = "a%20b";\nconst t = "${plus}";`, { in: 'text' })).not.toContain(plus)
    expect(withCookie('AbC123xYz%2BqWe%3D').text('t = "AbC123xYz+qWe="')).not.toContain('AbC123xYz+qWe=')
  })

  it('never decodes or rewrites code it scans', () => {
    const code = '// x\nconst u = "/a%2Fb?q=%20"; i = a + b; t = "Zq81kLmN03pp"\n'
    const out = withCookie('Zq81kLmN03pp').text(code)
    expect(out).toBe(code.replace('Zq81kLmN03pp', '<redacted: 12 chars>'))
    expect(withCookie('Zq81kLmN03pp').value(code, { in: 'text' })).toBe(out)
  })
})

describe('createRedactor: opaque blobs', () => {
  const blob = 'Qm9vT2pLcFh5ZVd6M1JhTnNUdUlvUG1BYkNkRWZHaElqS2xNbk9wUXJTdFV2V3hZeg'.repeat(5)
  const fingerprint = 'hX7kQ2mZpL9vRt4WcB8nYd3JfS6gAe1U'

  it('masks long opaque strings in examples by shape, nested or not', () => {
    const r = redactor([
      exchange({
        url: 'https://shop.test/api/dlg',
        method: 'POST',
        requestBody: jsonBody({
          body: { a13: blob, a14: fingerprint, a2: 'www.shop.test' },
        }),
      }),
    ])
    expect(r.examples([
      {
        body: { a13: blob, a14: fingerprint, a2: 'www.shop.test' },
      },
    ], { in: 'body' })).toEqual([
      {
        body: { a13: `<redacted: ${blob.length} base64 chars>`, a14: '<redacted: 32 base64 chars>', a2: 'www.shop.test' },
      },
    ])
    expect(r.value(JSON.stringify({ data: blob }), { in: 'body' })).toBe(`{"data":"<redacted: ${blob.length} base64 chars>"}`)
  })

  it('keeps a blob identical in every session, like any constant', () => {
    const items = ['s1', 's2'].map(sessionId => exchange({
      url: 'https://shop.test/api/key',
      sessionId,
      responseBody: jsonBody({ publicKey: blob }),
    }))
    expect(redactor(items).value(blob, { in: 'response-body', name: 'publicKey' })).toBe(blob)
  })
})

describe('createRedactor: secret object keys (decision 0042)', () => {
  const sessionToken = 'Zq8xT2mLp4VwRk7YbN3c'
  const cookie = 'c0ffee00deadbeef0123456789abcdef'
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'
  const userId = '3f2c9a4e-1b7d-4c8e-9f60-2a5b8c1d7e43'

  function capture(sessionId: string): Exchange[] {
    return [
      exchange({
        url: 'https://shop.test/api/me',
        sessionId,
        cookies: { sid: cookie },
        responseBody: jsonBody({ userId, name: 'x' }),
      }),
      exchange({
        url: 'https://shop.test/api/sessions',
        sessionId,
        responseBody: jsonBody({
          sessions: {
            [sessionToken]: { device: 'web' },
          },
        }),
      }),
    ]
  }

  it('recognises keys that are tokens, JWTs, learnt secrets, personal data or personal values', () => {
    const r = redactor(capture('s1'))
    for (const key of [
      sessionToken,
      jwt,
      cookie,
      userId,
      'a.person@example.com',
      `user:${cookie}`,
    ])
      expect(r.isSecretKey(key), key).toBe(true)
  })

  it('keeps ordinary keys, including long camelCase names, ids and dates', () => {
    const r = redactor(capture('s1'))
    for (const key of [
      'sessions',
      'device',
      'isPromotionalOfferEligible',
      'shipping_address_line_2',
      '__proto__',
      'constructor',
      '2024-01-31',
      '1001',
      'en-IN',
      '9a0364b9e99bb480dd25e1f0284c8555',
      '',
    ])
      expect(r.isSecretKey(key), key).toBe(false)
  })

  it('replaces secret keys in json, examples and nested JSON text by their shape, keeping values', () => {
    const r = redactor(capture('s1'))
    const body = {
      sessions: {
        [sessionToken]: { device: 'web' },
        count: 1,
      },
    }
    const expected = {
      sessions: {
        '<redacted: 20 base64 chars>': { device: 'web' },
        'count': 1,
      },
    }
    expect(r.json(body, { in: 'response-body' })).toEqual(expected)
    expect(r.examples([body], { in: 'response-body' })).toEqual([expected])
    expect(r.value(JSON.stringify(body), { in: 'response-body' })).toBe(JSON.stringify(expected))
  })

  it('numbers keys of the same shape so no entry is lost, and never renames ordinary keys', () => {
    const other = 'c0ffee00deadbeef0123456789abcdee'
    const r = redactor([
      ...capture('s1'),
      exchange({
        url: 'https://shop.test/api/x',
        cookies: { sid2: other },
      }),
    ])
    expect(r.json({
      '<redacted: 32 hex chars>': 'a',
      [cookie]: 'b',
      [other]: 'c',
    }, { in: 'body' })).toEqual({
      '<redacted: 32 hex chars>': 'a',
      '<redacted: 32 hex chars> (2)': 'b',
      '<redacted: 32 hex chars> (3)': 'c',
    })
  })

  it('names a value under a secret key by the map that holds it', () => {
    const r = redactor(capture('s1'))
    expect(r.json({
      tokens: { [sessionToken]: 'hunter22' },
    }, { in: 'body' })).toEqual({
      tokens: { '<redacted: 20 base64 chars>': '<redacted: 8 chars>' },
    })
  })

  it('masks secret keys in bot-protection payloads too', () => {
    const r = redactor(capture('s1'))
    expect(r.browserOnly.json({ [jwt]: 1 }, { in: 'body' })).toEqual({
      '<redacted: JWT (alg=HS256, claims=[sub])>': '<redacted: 1-digit number>',
    })
  })

  it('keeps an opaque key identical in every session, like an opaque value', () => {
    const r = redactor([
      ...capture('s1'),
      ...capture('s2'),
    ])
    expect(r.isSecretKey(sessionToken)).toBe(false)
    expect(r.isSecretKey(cookie)).toBe(true)
  })

  it('learns an opaque key as a secret, so the same token is removed from other text', () => {
    const r = redactor(capture('s1'))
    expect(r.value(`ref=${sessionToken}`, { in: 'text' })).toBe('ref=<redacted: 20 base64 chars>')
  })

  it('leaves keys alone in raw mode but still reports them', () => {
    const r = redactor(capture('s1'), { examples: 'raw' })
    const body = {
      sessions: {
        [sessionToken]: { device: 'web' },
      },
    }
    expect(r.json(body, { in: 'body' })).toEqual(body)
    expect(r.isSecretKey(sessionToken)).toBe(true)
  })
})

describe('createRedactor: tracking identifiers (decision 0045)', () => {
  const visitor = '7a72e88f-a0f1-4326-9b1c-2f4d6e8a0b13'
  const device = 'dev-4f9a2c71e3'

  function visit(sessionId: string, visitorId = visitor): Exchange {
    return exchange({
      url: `https://api.shop.test/feed?cid=${sessionId}.1700000000&uid=88${sessionId}21`,
      sessionId,
      requestHeaders: { 'x-nike-visitorid': visitorId },
      requestBody: jsonBody({
        consumer: { visitorId, deviceId: device, adobeMarketingCloudId: 80364217152279 },
        anonymousId: `anon-${sessionId}-77`,
      }),
    })
  }

  it('recognises visitor, device, anonymous and client id names, and leaves other ids alone', () => {
    for (const name of [
      'x-nike-visitorid',
      'visitorId',
      'visitor_id',
      'deviceid',
      'anonymousId',
      'clientId',
      'cid',
      'uid',
      '_ga',
      'adobeMarketingCloudId',
    ])
      expect(isTrackingIdName(name), name).toBe(true)
    for (const name of [
      'productId',
      'guid',
      'acid',
      'orderId',
      'visitor',
      'id',
      null,
    ])
      expect(isTrackingIdName(name), String(name)).toBe(false)
  })

  it('masks tracking ids in headers, query, bodies, numbers and examples', () => {
    const r = redactor([
      visit('s1'),
    ])
    expect(r.value(visitor, { in: 'header', name: 'x-nike-visitorid' })).toBe('<redacted: UUID>')
    expect(r.value('s1.1700000000', { in: 'query', name: 'cid' })).toBe('<redacted: 13 chars, separators ".">')
    expect(r.json({
      consumer: { visitorId: visitor, adobeMarketingCloudId: 80364217152279 },
    }, { in: 'body' })).toEqual({
      consumer: { visitorId: '<redacted: UUID>', adobeMarketingCloudId: '<redacted: 14-digit number>' },
    })
    expect(r.examples([
      { anonymousId: 'anon-s1-77', deviceId: device },
    ], { in: 'body' })).toEqual([
      { anonymousId: '<redacted: 10 chars>', deviceId: '<redacted: 14 chars>' },
    ])
    expect(r.value('42', { in: 'query', name: 'uid' })).toBe('<redacted: 2-digit number>')
  })

  it('removes a learnt tracking id wherever else it appears', () => {
    const r = redactor([
      visit('s1'),
    ])
    expect(r.value(`https://www.shop.test/p?ref=${visitor}`, { in: 'text' })).toBe('https://www.shop.test/p?ref=<redacted: UUID>')
    expect(r.value(`seen ${device} today`, { in: 'text' })).toBe('seen <redacted: 14 chars> today')
  })

  it('keeps an id identical in every session, like a publishable key, but never a session id', () => {
    const r = redactor([
      visit('s1'),
      visit('s2'),
    ])
    expect(r.value(visitor, { in: 'header', name: 'x-nike-visitorid' })).toBe(visitor)
    expect(r.value(device, { in: 'body', name: 'deviceId' })).toBe(device)
    expect(r.value('anon-s1-77', { in: 'body', name: 'anonymousId' })).toBe('<redacted: 10 chars>')
    const sessions = redactor(['s1', 's2'].map(sessionId => exchange({
      url: 'https://api.shop.test/x',
      sessionId,
      requestHeaders: { 'x-session-id': visitor },
    })))
    expect(sessions.value(visitor, { in: 'header', name: 'x-session-id' })).toBe('<redacted: UUID>')
  })
})

describe('createRedactor: URLs inside values (decision 0047)', () => {
  const token = 'PH8DAQEIZW52aXJvbm1lbnQBCQAAAAZ3c3Rva2Vu'
  const recovery = `wss://hermes.twitch.tv/a/v1?clientId=kimne78kx3ncx6brgo4mv6wki5h1ko&t=${token}`

  function welcome(sessionId = 's1'): Exchange {
    return exchange({
      url: 'https://www.shop.test/api/socket-config',
      sessionId,
      responseBody: jsonBody({
        type: 'welcome',
        payload: { recoveryUrl: recovery },
      }),
    })
  }

  it('redacts query tokens of a WebSocket URL in a body value, by name', () => {
    const r = redactor([
      welcome(),
    ])
    const redacted = JSON.stringify(r.json({
      payload: { recoveryUrl: recovery },
    }, { in: 'response-body' }))
    expect(redacted).not.toContain(token)
    expect(redacted).toContain('t=<redacted: 40 base64 chars>')
  })

  it('learns the token, so it is scrubbed where it appears elsewhere', () => {
    const r = redactor([
      welcome(),
    ])
    expect(r.value(`resume ${token}`, { in: 'text' })).toBe('resume <redacted: 40 base64 chars>')
  })

  it('redacts URLs inside longer text and keeps the punctuation around them', () => {
    const r = redactor([])
    expect(r.value(`Reconnect to ${recovery}.`, { in: 'response-body', name: 'message' }))
      .toBe('Reconnect to wss://hermes.twitch.tv/a/v1?clientId=<redacted: 30 base64 chars>&t=<redacted: 40 base64 chars>.')
  })

  it('redacts a Location header, path credentials, user info and random query values like request URLs', () => {
    const r = redactor([])
    expect(r.value('https://shop.test/cb?session=abc123def&page=2', { in: 'response-header', name: 'location' }))
      .toBe('https://shop.test/cb?session=<redacted: 9 hex chars>&page=2')
    expect(r.value('see https://shop.test/reset/Zq8xT2mLp4VwRk7YbN3c now', { in: 'body', name: 'note' }))
      .toBe('see https://shop.test/reset/<redacted: 20 base64 chars> now')
    expect(r.value('https://admin:hunter22@shop.test/x', { in: 'body', name: 'link' }))
      .toBe('https://<redacted: 14 chars, separators ":">@shop.test/x')
    expect(r.value('https://cdn.test/f?x-id=Zq8xT2mLp4VwRk7YbN3c', { in: 'body', name: 'href' }))
      .toBe('https://cdn.test/f?x-id=<redacted: 20 base64 chars>')
  })

  it('redacts and learns tokens in fragments and in a hash router\'s query', () => {
    const routed = 'https://shop.test/#/cb?token=Zq8xT2mLp4VwRk7YbN3c&page=2'
    const implicit = 'https://shop.test/cb?a=1#access_token=hX7kQ2mZpL9vRt4WcB8n&state=ok'
    const r = redactor([
      exchange({
        url: 'https://shop.test/api/a',
        responseBody: jsonBody({ next: routed, back: implicit }),
      }),
    ])
    expect(r.value(routed, { in: 'body', name: 'next' })).toBe('https://shop.test/#/cb?token=<redacted: 20 base64 chars>&page=2')
    expect(r.value(implicit, { in: 'body', name: 'back' })).toBe('https://shop.test/cb?a=1#access_token=<redacted: 20 base64 chars>&state=ok')
    // Learnt, so the tokens are removed from unrelated text too.
    expect(r.value('a Zq8xT2mLp4VwRk7YbN3c b hX7kQ2mZpL9vRt4WcB8n', { in: 'text' }))
      .toBe('a <redacted: 20 base64 chars> b <redacted: 20 base64 chars>')
  })

  it('keeps only Unix times and short offsets under t', () => {
    const r = redactor([])
    for (const value of [
      '1700000000',
      '1700000000123',
      '90s',
      '1m30s',
      '1h2m3s',
    ])
      expect(r.value(value, { in: 'query', name: 't' }), value).toBe(value)
    for (const value of [
      '84736251908374',
      '90',
      '123456789',
      'abc',
    ])
      expect(r.value(value, { in: 'query', name: 't' }), value).toMatch(/^<redacted: /)
  })

  it('keeps times and offsets under t, and ordinary URLs unchanged', () => {
    const r = redactor([])
    for (const url of [
      'https://video.test/watch?v=abc&t=1m30s',
      'https://api.test/poll?t=1700000000123',
      'https://shop.test/products/masala-makhana-250-g?page=2#reviews',
    ])
      expect(r.value(url, { in: 'body', name: 'href' }), url).toBe(url)
    expect(isSecretName('x-t-id', true)).toBe(false)
    expect(isSecretName('t', true)).toBe(true)
    expect(isSecretName('t')).toBe(false)
  })
})

describe('createRedactor: learntSecrets (decision 0047)', () => {
  it('lists token-like secrets from cookies, headers, bodies and URLs, never words or short values', () => {
    const r = redactor([
      exchange({
        url: 'https://shop.test/api/x',
        cookies: { sid: 'c0ffee00deadbeef0123', layout: 'desktop-layout-wide', n: 'a1b2' },
        requestHeaders: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' },
        responseBody: jsonBody({ recoveryUrl: 'wss://h.test/a?t=PH8DAQEIZW52aXJvbm1lbnQ' }),
      }),
    ])
    const secrets = r.learntSecrets()
    expect(secrets).toContain('c0ffee00deadbeef0123')
    expect(secrets).toContain('PH8DAQEIZW52aXJvbm1lbnQ')
    expect(secrets.some(secret => secret.includes('eyJhbGciOiJIUzI1NiJ9'))).toBe(true)
    expect(secrets).not.toContain('desktop-layout-wide')
    expect(secrets).not.toContain('a1b2')
    expect(secrets).toEqual([...secrets].sort())
  })
})

describe('createRedactor: short secrets and public labels', () => {
  it('never learns a host label sent under a key name, and keeps it wherever it is redacted', () => {
    const r = redactor([
      exchange({
        url: 'https://www.pagebook.so/api/v3/getSpaces',
        method: 'POST',
        requestBody: jsonBody({ api_key: 'pagebook' }),
      }),
    ])
    expect(r.value('https://www.pagebook.so/api', { in: 'text' })).toBe('https://www.pagebook.so/api')
    expect(r.value('x-pagebook-client-version', { in: 'text' })).toBe('x-pagebook-client-version')
    expect(r.value('Open pagebook to continue', { in: 'text' })).toBe('Open pagebook to continue')
    expect(r.value('pagebook', { in: 'body', name: 'api_key' })).toBe('pagebook')
    expect(r.value('pagebook', { in: 'header', name: 'x-api-key' })).toBe('pagebook')
    expect(r.learntSecrets()).toEqual([])
  })

  it('keeps a short lower-case word under a name that says the key is public', () => {
    const r = redactor([
      exchange({
        url: 'https://shop.test/api/x',
        method: 'POST',
        requestBody: jsonBody({ siteKey: 'docs' }),
      }),
    ])
    expect(r.value('docs', { in: 'body', name: 'siteKey' })).toBe('docs')
  })

  it('never keeps a key by its shape: letters-only and word-like keys stay secret unless constant', () => {
    for (const key of [
      'KxRtQmPzLwVbNnHjGfDsAa',
      'Kx-RtQmPz_LwVbNn',
      'correct-horse-battery-staple',
      'webapp',
    ]) {
      const r = redactor([
        exchange({
          url: 'https://api.shop.test/v1/x',
          requestHeaders: { 'x-api-key': key },
          responseBody: jsonBody({ note: `k ${key}` }),
        }),
      ])
      expect(r.value(key, { in: 'header', name: 'x-api-key' }), key).toMatch(/^<redacted: /)
      expect(r.value(key, { in: 'query', name: 'api_key' }), key).toMatch(/^<redacted: /)
      expect(r.value(`use ${key} now`, { in: 'response-body', name: 'note' }), key).not.toContain(key)
    }
  })

  it('still treats a real key under a key name as a secret unless constant', () => {
    const r = redactor([
      exchange({
        url: 'https://www.pagebook.so/api/x',
        method: 'POST',
        requestBody: jsonBody({ api_key: 'pk_9f3a7c21e8b4' }),
      }),
    ])
    expect(r.value('pk_9f3a7c21e8b4', { in: 'body', name: 'api_key' })).toBe('<redacted: 15 chars>')
    expect(r.value('use pk_9f3a7c21e8b4 here', { in: 'text' })).toBe('use <redacted: 15 chars> here')
  })

  it('replaces short secrets with digits wherever they occur, and checks them for leaks', () => {
    const sid = 'a1b2c3d4e5'
    const r = redactor([
      exchange({
        url: 'https://shop.test/api/x',
        cookies: { sid },
      }),
    ])
    for (const text of [
      `/files/${sid}.json`,
      `uid_${sid}`,
      `user-${sid}`,
      `x.${sid}`,
      `${sid}-x`,
      `"${sid}"`,
      `sid=${sid}`,
      `${sid}.`,
      `https://cdn.test/${sid}.js`,
    ])
      expect(r.value(text, { in: 'response-body', name: 'note' }), text).not.toContain(sid)
    expect(r.learntSecrets()).toContain(sid)
  })

  it('replaces short letters-only secrets only as whole words', () => {
    const r = redactor([
      exchange({
        url: 'https://shop.test/api/x',
        cookies: { theme: 'kqzvwx' },
      }),
    ])
    expect(r.value('a kqzvwx b, kqzvwx.json, user-kqzvwx', { in: 'text' }))
      .toBe('a <redacted: 6 chars> b, <redacted: 6 chars>.json, user-<redacted: 6 chars>')
    for (const text of ['kqzvwxmode', 'xkqzvwx', 'kqzvwx2'])
      expect(r.value(text, { in: 'text' }), text).toBe(text)
  })

  it('replaces long learnt secrets anywhere, also inside other text', () => {
    const long = 'c0ffee00deadbeef0123'
    const r = redactor([
      exchange({
        url: 'https://shop.test/api/x',
        cookies: { sid: long },
      }),
    ])
    expect(r.value(`prefix${long}suffix`, { in: 'text' })).toBe('prefix<redacted: 20 hex chars>suffix')
  })
})

describe('createRedactor: device and ad signals (decision 0049)', () => {
  const signals = 'dt=1700000000123&flash=0&u_tz=60&u_his=3&u_h=900&u_w=1440&biw=1425&brdim=-10%2C20%2C1440&vis=1'
  const device = 'cbr=Chrome&cbrand=apple&cbrver=120.0.0.0&cos=Macintosh&cosver=10_15_7&cplatform=DESKTOP'

  it('masks custom device and ad-signal headers, keeping the parameter names', () => {
    const r = redactor([])
    expect(r.value(signals, { in: 'header', name: 'x-tube-ad-signals' }))
      .toBe('dt=0000000000000&flash=0&u_tz=00&u_his=0&u_h=000&u_w=0000&biw=0000&brdim=-00%0X00%0X0000&vis=0')
    expect(r.value(device, { in: 'header', name: 'x-tube-device' }))
      .toBe('cbr=Xxxxxx&cbrand=xxxxx&cbrver=000.0.0.0&cos=Xxxxxxxxx&cosver=00_00_0&cplatform=XXXXXXX')
    expect(r.value('{"w":1440}', { in: 'header', name: 'x-device-info' })).toBe('{"x":0000}')
  })

  it('masks a parameter list that carries device signals under any name or place', () => {
    const r = redactor([])
    expect(r.value(signals, { in: 'query', name: 'extra' })).not.toContain('1440')
    expect(r.examples([
      { ctx: device },
    ], { in: 'body' })).toEqual([
      { ctx: 'cbr=Xxxxxx&cbrand=xxxxx&cbrver=000.0.0.0&cos=Xxxxxxxxx&cosver=00_00_0&cplatform=XXXXXXX' },
    ])
  })

  it('keeps standard headers and ordinary values', () => {
    const r = redactor([])
    expect(r.value('?0', { in: 'header', name: 'sec-ch-ua-mobile' })).toBe('?0')
    expect(r.value('8', { in: 'header', name: 'device-memory' })).toBe('8')
    expect(r.value('2.20240101.01.00', { in: 'header', name: 'x-tube-client-version' })).toBe('2.20240101.01.00')
    expect(r.value('q=shoes&page=2', { in: 'query', name: 'next' })).toBe('q=shoes&page=2')
  })
})

describe('createRedactor: escaped and protocol-relative URLs', () => {
  it('redacts and learns tokens in JSON-escaped URLs, keeping the escaping', () => {
    const text = 'window.cfg = {"next":"https:\\/\\/shop.test\\/cb?token=Zq8xT2mLp4VwRk7YbN3c&page=2"}'
    const r = redactor([
      exchange({
        url: 'https://shop.test/',
        responseBody: textBody(`<script>${text}</script>`),
      }),
    ])
    expect(r.value(text, { in: 'response-body' }))
      .toBe('window.cfg = {"next":"https:\\/\\/shop.test\\/cb?token=<redacted: 20 base64 chars>&page=2"}')
    expect(r.value('copy Zq8xT2mLp4VwRk7YbN3c', { in: 'text' })).toBe('copy <redacted: 20 base64 chars>')
  })

  it('redacts and learns tokens in protocol-relative URLs, and leaves code comments alone', () => {
    const text = 'load //cdn.shop.test/a.js?sig=hX7kQ2mZpL9vRt4WcB8n then // note: done'
    const r = redactor([
      exchange({
        url: 'https://shop.test/',
        responseBody: textBody(text),
      }),
    ])
    expect(r.value(text, { in: 'response-body' }))
      .toBe('load //cdn.shop.test/a.js?sig=<redacted: 20 base64 chars> then // note: done')
    expect(r.value('x hX7kQ2mZpL9vRt4WcB8n', { in: 'text' })).toBe('x <redacted: 20 base64 chars>')
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
