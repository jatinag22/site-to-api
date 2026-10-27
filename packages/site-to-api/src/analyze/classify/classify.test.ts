import type { ExchangeInit } from '../../../test/helpers'
import type { Exchange } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, formBody, jsonBody, textBody } from '../../../test/helpers'
import { looksLikeRandomSensorPath } from './bot-protection'
import { classifyExchanges } from './classify'
import { compileHostGlobs } from './host-glob'

const PAGE = 'https://shop.test/'

function on(init: ExchangeInit & { pageUrl?: string | null }): Exchange {
  const built = exchange({ kind: 'noise', ...init })
  return {
    ...built,
    pageUrl: init.pageUrl === undefined
      ? PAGE
      : init.pageUrl,
  }
}

function page(): Exchange {
  return on({
    url: PAGE,
    resourceType: 'document',
    responseBody: textBody('<html></html>'),
    pageUrl: null,
  })
}

function classify(list: Exchange[], include: string[] = [], exclude: string[] = []): ReturnType<typeof classifyExchanges> {
  return classifyExchanges(list, { include, exclude })
}

function kinds(list: Exchange[], include: string[] = [], exclude: string[] = []): string[] {
  return classify(list, include, exclude).exchanges.map(item => item.kind)
}

describe('classifyExchanges: resource and media types', () => {
  it('labels documents, assets and data calls', () => {
    expect(kinds([
      page(),
      on({ url: 'https://shop.test/app.js', resourceType: 'script' }),
      on({ url: 'https://shop.test/a.png', resourceType: 'image' }),
      on({ url: 'https://shop.test/f.woff2', resourceType: 'font' }),
      on({ url: 'https://shop.test/s.css', resourceType: 'stylesheet' }),
      on({ url: 'https://shop.test/v.mp4', resourceType: 'media' }),
      on({ url: 'https://shop.test/m.json', resourceType: 'manifest' }),
      on({
        url: 'https://shop.test/api/a',
        resourceType: 'fetch',
        responseBody: jsonBody({ a: 1 }),
      }),
      on({
        url: 'https://shop.test/api/b',
        resourceType: 'xhr',
        responseBody: textBody('<p>x</p>'),
      }),
      on({
        url: 'https://shop.test/api/c',
        resourceType: 'other',
        responseBody: textBody('a,b', 'text/csv'),
      }),
      on({
        url: 'https://shop.test/api/d',
        resourceType: 'fetch',
        responseBody: textBody('<r/>', 'application/xml'),
      }),
    ])).toEqual([
      'page',
      'asset',
      'asset',
      'asset',
      'asset',
      'asset',
      'asset',
      'api',
      'api',
      'api',
      'api',
    ])
  })

  it('treats JSON with a wrong content type, empty responses and binary downloads as api', () => {
    const wrongType = {
      ...jsonBody({ a: 1 }),
      mimeType: 'text/javascript',
    }
    const pdf = {
      mimeType: 'application/pdf',
      text: null,
      base64: 'JVBERi0=',
      json: undefined,
      form: null,
    }
    expect(kinds([
      page(),
      on({ url: 'https://shop.test/api/a', responseBody: wrongType }),
      on({ method: 'DELETE', url: 'https://shop.test/api/item/1', status: 204 }),
      on({ url: 'https://shop.test/api/report.pdf', responseBody: pdf }),
    ])).toEqual(['page', 'api', 'api', 'api'])
  })

  it('drops preflights, image fetches and fire-and-forget beacons', () => {
    const png = {
      mimeType: 'image/png',
      text: null,
      base64: 'iVBO',
      json: undefined,
      form: null,
    }
    expect(kinds([
      page(),
      on({ method: 'OPTIONS', url: 'https://shop.test/api/a' }),
      on({ url: 'https://shop.test/thumb', responseBody: png }),
      on({
        method: 'POST',
        url: 'https://shop.test/log',
        resourceType: 'beacon',
        requestBody: jsonBody({ e: 1 }),
      }),
      on({ url: 'wss://shop.test/socket', resourceType: 'websocket' }),
    ])).toEqual([
      'page',
      'noise',
      'asset',
      'noise',
      'noise',
    ])
  })
})

describe('classifyExchanges: hosts', () => {
  it('by default keeps page hosts and hosts the pages called, minus noise domains', () => {
    const result = classify([
      page(),
      on({
        url: 'https://api.shop.test/v1/items',
        responseBody: jsonBody([]),
      }),
      on({
        url: 'https://www.google-analytics.com/g/collect',
        responseBody: jsonBody({}),
      }),
      on({
        url: 'https://www.facebook.com/tr',
        responseBody: jsonBody({}),
      }),
      on({
        url: 'https://elsewhere.test/api',
        responseBody: jsonBody({}),
        pageUrl: 'https://elsewhere.test/',
      }),
    ])
    expect(result.exchanges.map(item => [item.kind, item.kindReason])).toEqual([
      ['page', 'document'],
      ['api', 'fetch returning application/json'],
      ['noise', 'analytics, ads or telemetry (google-analytics.com)'],
      ['noise', 'analytics, ads or telemetry (www.facebook.com/tr)'],
      ['noise', 'host out of scope: it served no page and no page called it'],
    ])
  })

  it('honours include and exclude globs, exclude winning', () => {
    const list = [
      page(),
      on({
        url: 'https://api.shop.test/a',
        responseBody: jsonBody({}),
      }),
      on({
        url: 'https://cdn.shop.test/b',
        responseBody: jsonBody({}),
      }),
      on({
        url: 'https://other.test/c',
        responseBody: jsonBody({}),
      }),
    ]
    expect(kinds(list, ['*.shop.test'], ['cdn.*'])).toEqual(['noise', 'api', 'noise', 'noise'])
    expect(kinds(list, ['shop.test', 'other.test'])).toEqual(['page', 'noise', 'noise', 'api'])
    expect(classify(list, [], ['shop.test']).exchanges[0]!.kindReason).toBe('host excluded by hosts.exclude')
  })

  it('does not label unrelated hosts that were never called from a page', () => {
    expect(kinds([
      on({
        url: 'https://api.shop.test/a',
        responseBody: jsonBody({}),
        pageUrl: null,
      }),
    ])).toEqual(['noise'])
  })
})

describe('compileHostGlobs', () => {
  it('matches subdomains, ignores case and optional ports', () => {
    const match = compileHostGlobs(['*.example.com', 'localhost:3000'])
    expect(match('API.example.com')).toBe(true)
    expect(match('a.b.example.com:8443')).toBe(true)
    expect(match('example.com')).toBe(false)
    expect(match('example.com.evil.test')).toBe(false)
    expect(match('localhost:3000')).toBe(true)
    expect(match('localhost:4000')).toBe(false)
  })
})

describe('classifyExchanges: bot protection', () => {
  it('detects Akamai sensor posts and keeps the API calls that carry its cookies as api', () => {
    const akamaiCookies = { _abck: 'x', bm_sz: 'y' }
    const result = classify([
      page(),
      on({
        method: 'POST',
        url: 'https://shop.test/Xb4Ks/Ld0x/qP9/nHvO2kq',
        cookies: akamaiCookies,
        requestBody: jsonBody({ sensor_data: 'z' }),
        responseBody: jsonBody({ success: true }),
      }),
      on({
        method: 'POST',
        url: 'https://shop.test/AQh2b-7BP/Fq3/HCC1/Yo2vE_k',
        cookies: akamaiCookies,
        requestBody: textBody('opaque', 'text/plain'),
        responseBody: jsonBody({}),
      }),
      on({
        url: 'https://shop.test/api/items',
        cookies: akamaiCookies,
        responseBody: jsonBody([]),
      }),
    ])
    expect(result.exchanges.map(item => item.kind)).toEqual([
      'page',
      'bot-protection',
      'bot-protection',
      'api',
    ])
    expect(result.exchanges[2]!.kindReason).toBe('Akamai: POST to a random-looking first-party path')
    expect(result.botProtection).toHaveLength(1)
    expect(result.botProtection[0]).toMatchObject({ vendor: 'Akamai', host: 'shop.test' })
    expect(result.botProtection[0]!.evidence).toContain('cookie _abck')
    expect(result.botProtection[0]!.evidence).toContain('request body matches sensor_data')
    expect(result.botProtection[0]!.exchangeIds).toHaveLength(3)
  })

  it('does not treat random-looking paths as Akamai without Akamai cookies', () => {
    expect(kinds([
      page(),
      on({
        method: 'POST',
        url: 'https://shop.test/Xb4Ks/Ld0x/qP9',
        responseBody: jsonBody({}),
      }),
    ])).toEqual(['page', 'api'])
  })

  it.each([
    [
      'Cloudflare',
      on({
        url: 'https://shop.test/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1',
        responseBody: textBody('x', 'text/plain'),
      }),
    ],
    [
      'Cloudflare',
      on({
        url: 'https://shop.test/blocked',
        responseHeaders: { 'cf-mitigated': 'challenge' },
        responseBody: textBody('<html>'),
      }),
    ],
    [
      'Cloudflare Turnstile',
      on({
        url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2',
        resourceType: 'document',
        responseBody: textBody('<html>'),
      }),
    ],
    [
      'PerimeterX',
      on({
        method: 'POST',
        url: 'https://shop.test/abCD1234/xhr/api/v2/collector',
        requestBody: formBody({ payload: 'p' }),
        responseBody: jsonBody({ do: [] }),
      }),
    ],
    [
      'PerimeterX',
      on({
        method: 'POST',
        url: 'https://collector-pxabc.px-cloud.net/api/v2/collector',
        responseBody: jsonBody({}),
      }),
    ],
    [
      'DataDome',
      on({
        method: 'POST',
        url: 'https://api-js.datadome.co/js/',
        requestBody: formBody({ jsData: 'j' }),
        responseBody: jsonBody({ status: 200 }),
      }),
    ],
    [
      'Imperva',
      on({
        url: 'https://shop.test/_Incapsula_Resource?SWJIYLWA=1',
        responseBody: textBody('x', 'text/plain'),
      }),
    ],
    [
      'Kasada',
      on({
        method: 'POST',
        url: 'https://shop.test/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/tl',
        responseBody: jsonBody({}),
      }),
    ],
    [
      'reCAPTCHA',
      on({
        method: 'POST',
        url: 'https://www.google.com/recaptcha/api2/reload?k=key',
        responseBody: textBody(')]}\'', 'application/json'),
      }),
    ],
    [
      'hCaptcha',
      on({
        method: 'POST',
        url: 'https://api.hcaptcha.com/checksiteconfig',
        responseBody: jsonBody({ pass: true }),
      }),
    ],
  ])('detects %s traffic', (vendor, item) => {
    const result = classify([
      page(),
      item,
    ])
    expect(result.exchanges[1]!.kind).toBe('bot-protection')
    expect(result.exchanges[1]!.kindReason.startsWith(`${vendor}:`)).toBe(true)
    expect(result.botProtection.map(finding => [finding.vendor, finding.host])).toContainEqual([vendor, 'shop.test'])
  })

  it.each([
    [
      'Cloudflare',
      {
        cookies: { cf_clearance: 'c' },
      },
    ],
    [
      'PerimeterX',
      {
        cookies: { _px3: 'p' },
      },
    ],
    [
      'DataDome',
      {
        cookies: { datadome: 'd' },
      },
    ],
    [
      'Imperva',
      {
        cookies: { incap_ses_123_456: 'i' },
      },
    ],
    [
      'Imperva',
      {
        cookies: { reese84: 'r' },
      },
    ],
    [
      'Kasada',
      {
        requestHeaders: { 'x-kpsdk-ct': 'k' },
      },
    ],
  ])('records %s cookies and headers as evidence without relabelling the call', (vendor, init) => {
    const result = classify([
      page(),
      on({
        url: 'https://shop.test/api/a',
        responseBody: jsonBody({}),
        ...init,
      }),
    ])
    expect(result.exchanges[1]!.kind).toBe('api')
    expect(result.botProtection.map(finding => finding.vendor)).toEqual([vendor])
  })

  it('keeps vendor scripts out of the specs, still reports the vendor, and skips findings on hosts outside the analysis', () => {
    const result = classify([
      page(),
      on({ url: 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', resourceType: 'script' }),
      on({
        url: 'https://cdn.other.test/lib.js',
        resourceType: 'script',
        setCookies: { __cf_bm: 'b' },
        pageUrl: 'https://cdn.other.test/',
      }),
    ])
    expect(result.exchanges.map(item => item.kind)).toEqual(['page', 'noise', 'noise'])
    expect(result.botProtection.map(finding => [finding.vendor, finding.host])).toEqual([
      ['reCAPTCHA', 'shop.test'],
    ])
  })
})

describe('looksLikeRandomSensorPath', () => {
  it('accepts mixed-case random segments and rejects word paths', () => {
    expect(looksLikeRandomSensorPath('/Xb4Ks/Ld0x/qP9/nHvO2kq')).toBe(true)
    expect(looksLikeRandomSensorPath('/api/v1/users')).toBe(false)
    expect(looksLikeRandomSensorPath('/api/products/A1b2')).toBe(false)
    expect(looksLikeRandomSensorPath('/Ab1')).toBe(false)
  })
})
