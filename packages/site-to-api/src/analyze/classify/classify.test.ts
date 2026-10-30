import type { ExchangeInit } from '../../../test/helpers'
import type { Exchange } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, formBody, jsonBody, textBody } from '../../../test/helpers'
import { challengePageMarker, looksLikeRandomSensorPath } from './bot-protection'
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

describe('classifyExchanges: static files and pixel sandboxes (decision 0052)', () => {
  it('labels icons, manifests and named scripts and styles assets, whatever their resource type', () => {
    expect(kinds([
      page(),
      on({ url: 'https://shop.test/favicon.ico', resourceType: 'other' }),
      on({ url: 'https://shop.test/apple-touch-icon-180.png', resourceType: 'fetch' }),
      on({
        url: 'https://shop.test/manifest.json',
        resourceType: 'fetch',
        responseBody: jsonBody({ name: 'Shop' }),
      }),
      on({ url: 'https://shop.test/site.webmanifest', resourceType: 'other' }),
      on({ url: 'https://shop.test/cloud/checkout-web/assets/c1/polyfills-entry-modern.Ab12Cd.worker.js', resourceType: 'fetch' }),
      on({ url: 'https://shop.test/cloud/checkout-web/assets/c1/app.css', resourceType: 'other' }),
      on({
        url: 'https://shop.test/api/cart.json',
        resourceType: 'fetch',
        responseBody: jsonBody({ items: [] }),
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
    ])
  })

  it('treats Shopify web-pixel sandbox iframes as noise, not pages', () => {
    const frame = (path: string): Exchange => on({
      url: `https://shop.test${path}`,
      resourceType: 'document',
      responseBody: textBody('<html><body></body></html>'),
    })
    expect(kinds([
      page(),
      frame('/wpm@a1b2c3d4e5/app/web-pixel-12345@abcdef/sandbox/modern/products/shoe'),
      frame('/wpm@a1b2c3d4e5/custom/web-pixel-67890@2/sandbox/modern/'),
      frame('/products/sandbox'),
    ])).toEqual(['page', 'noise', 'noise', 'page'])
  })
})

describe('classifyExchanges: front-end build files and ad networks (decision 0046)', () => {
  it('labels prefetched build chunks assets, whatever their resource type', () => {
    expect(kinds([
      page(),
      // Next.js prefetch: `sec-purpose: prefetch`, recorded without a body.
      on({
        url: 'https://shop.test/_next/static/chunks/4283-560d7691b8e141c0.js',
        resourceType: 'other',
        requestHeaders: { 'sec-purpose': 'prefetch' },
      }),
      on({ url: 'https://shop.test/static/js/main.3f9a2c1e.chunk.js', resourceType: 'fetch' }),
      on({ url: 'https://shop.test/assets/index-4f2a9c81.css', resourceType: 'fetch' }),
      // Not build files: an API path and a plain file name without a hash.
      on({
        url: 'https://shop.test/api/static/items',
        resourceType: 'fetch',
        responseBody: jsonBody([]),
      }),
      on({
        url: 'https://shop.test/api/widget.js',
        resourceType: 'fetch',
        responseBody: jsonBody({}),
      }),
    ])).toEqual([
      'page',
      'asset',
      'asset',
      'asset',
      'api',
      'api',
    ])
  })

  it('labels identity-sync and ad-network hosts noise', () => {
    const result = classify([
      page(),
      on({
        url: 'https://sync.a-mo.net/usersync',
        resourceType: 'fetch',
        responseBody: jsonBody({}),
      }),
      on({
        url: 'https://request-global.czilladx.com/serve/view.php',
        resourceType: 'document',
        responseBody: textBody('<html></html>'),
      }),
      on({
        url: 'https://t.adx.opera.com/pub/sync',
        resourceType: 'fetch',
        responseBody: jsonBody({}),
      }),
    ])
    expect(result.exchanges.slice(1).map(item => item.kind)).toEqual(['noise', 'noise', 'noise'])
  })
})

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
      'Cloudflare',
      on({
        method: 'POST',
        url: 'https://shop.test/questions/tagged/typescript',
        resourceType: 'document',
        requestBody: formBody({ ['a1'.repeat(32)]: 'x', ['b2'.repeat(32)]: 'y' }),
        responseBody: textBody('<html><title>Questions</title></html>'),
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
      'Kasada',
      on({
        url: 'https://shop.test/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/mfc',
        requestHeaders: { 'x-kpsdk-h': '01', 'x-kpsdk-v': 'j-1.2.3' },
        responseHeaders: { 'x-kpsdk-fc': 'f', 'x-kpsdk-h': '01' },
        responseBody: {
          mimeType: 'x-unknown',
          text: null,
          base64: null,
          json: undefined,
          form: null,
        },
      }),
    ],
    [
      'AWS WAF',
      on({
        url: 'https://a1b2c3d4e5f6.0a1b2c3d.eu-west-1.token.awswaf.com/a1b2c3d4e5f6/0a1b2c3d4e5f/6a7b8c9d0e1f/inputs?client=browser',
        pageUrl: PAGE,
        responseBody: jsonBody({
          challenge: { input: 'i' },
          challenge_type: 't',
          difficulty: 1,
        }),
      }),
    ],
    [
      'AWS WAF',
      on({
        method: 'POST',
        url: 'https://a1b2c3d4e5f6.0a1b2c3d.eu-west-1.token.awswaf.com/a1b2c3d4e5f6/0a1b2c3d4e5f/6a7b8c9d0e1f/mp_verify',
        pageUrl: PAGE,
        requestBody: formBody({ solution_data: 's', solution_metadata: 'm' }),
        responseBody: jsonBody({ token: 't', inputs: {} }),
      }),
    ],
    [
      'AWS WAF',
      on({
        url: 'https://shop.test/api/prices',
        status: 202,
        responseHeaders: { 'x-amzn-waf-action': 'challenge' },
        responseBody: textBody('<html>'),
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
    [
      'AWS WAF',
      {
        cookies: { 'aws-waf-token': 'w' },
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

  it('describes vendor paths by a label, never by the captured path', () => {
    const token = 'Hq7ZpL2xVb9KmR4tWc8NyD3fJs6GaE1uYo5Tk0Xi'
    const result = classify([
      page(),
      on({
        method: 'POST',
        url: `https://shop.test/cdn-cgi/challenge-platform/h/g/jsd/oneshot/0a1b2c3d4e5f/0.4182736455:1700000000:${token}/9f8e7d6c5b4a3210`,
        responseBody: textBody('x', 'text/plain'),
      }),
      on({
        url: 'https://shop.test/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/mfc',
        responseBody: jsonBody({}),
      }),
    ])
    expect(result.exchanges[1]!.kindReason).toBe('Cloudflare: request to shop.test/cdn-cgi/challenge-platform/…')
    expect(result.botProtection.map(finding => finding.evidence)).toEqual([
      'request to shop.test/cdn-cgi/challenge-platform/…',
      'request to shop.test/<uuid>/<uuid>/mfc',
    ])
    expect(JSON.stringify(result.botProtection)).not.toContain(token)
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

describe('classifyExchanges: challenge frames', () => {
  it('reports captcha frames for the site that embeds them, never for the vendor host', () => {
    const anchor = 'https://www.google.com/recaptcha/api2/anchor?k=key'
    const result = classify([
      page(),
      on({ url: 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', resourceType: 'script' }),
      on({
        url: anchor,
        resourceType: 'document',
        responseBody: textBody('<html>'),
      }),
      on({
        url: 'https://www.google.com/recaptcha/api2/bframe?k=key',
        resourceType: 'document',
        responseBody: textBody('<html>'),
        pageUrl: anchor,
      }),
      on({
        url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2',
        resourceType: 'document',
        responseBody: textBody('<html>'),
        pageUrl: 'https://challenges.cloudflare.com/x',
      }),
    ])
    expect(result.exchanges.slice(2).map(item => item.kind)).toEqual(['bot-protection', 'bot-protection', 'bot-protection'])
    expect([
      ...new Set(result.botProtection.map(finding => finding.host)),
    ]).toEqual(['shop.test'])
  })
})

describe('classifyExchanges: telemetry and mirrors', () => {
  it('drops telemetry, RUM and health checks, and folds search mirrors into their main host', () => {
    const call = (url: string): Exchange => on({
      method: 'POST',
      url,
      responseBody: jsonBody({ ok: true }),
    })
    const result = classify([
      page(),
      call('https://telemetry.algolia.com/1/events'),
      call('https://app.datadoghq.com/rum/v1/input'),
      call('https://intake-analytics.wikimedia.org/v1/events'),
      call('https://app1-dsn.algolia.net/1/isalive'),
      call('https://app1-dsn.algolia.net/1/indexes/items/query'),
      call('https://app1-2.algolianet.com/1/indexes/items/query'),
      call('https://app2-3.algolianet.com/1/indexes/items/query'),
    ])
    expect(result.exchanges.map(item => item.kind)).toEqual([
      'page',
      'noise',
      'noise',
      'noise',
      'noise',
      'api',
      'noise',
      'api',
    ])
    expect(result.exchanges[6]!.kindReason).toBe('fallback mirror of app1-dsn.algolia.net, which the specs describe')
  })

  it('drops header-bidding, identity-sync and retail ad beacons', () => {
    const urls = [
      'https://lb.eu-1-id5-sync.com/lb/v1',
      'https://krk2.kargo.com/api/v1/prebid',
      'https://hbx.media.net/bidexchange.php',
      'https://edge.aditude.io/v1/config',
      'https://event-ingestor.judy.pnap.aditude.cloud/e',
      'https://geo-location.prebid.cloud/',
      'https://www.temu.com/api/adx/cm/pixel-pubmatic',
      'https://collect.shop.test/g/collect?v=2&tid=G-ABC123',
    ]
    expect(kinds([
      page(),
      ...urls.map(url => on({
        method: 'POST',
        url,
        responseBody: jsonBody({}),
      })),
    ]).slice(1)).toEqual(urls.map(() => 'noise'))
  })

  it('drops ad, RUM and tag-manager hosts, including the ones named by convention', () => {
    const urls = [
      'https://logx.optimizely.com/v1/events',
      'https://app.contentsquare.com/',
      'https://asia.creativecdn.com/tags/v2',
      'https://c.go-mpulse.net/api/config.json',
      'https://c.amazon-adsystem.com/aax2/apstag.js',
      'https://sdk-api-v1.singular.net/api/v1/event',
      'https://pixel-config.reddit.com/pixels/t2_x/config',
      'https://sgtm.shop.test/g/collect',
      'https://unagi.amazon.in/1/events/com.amazon.csm.csa.prod',
      'https://unagi-na.amazon.com/1/events/x',
    ]
    expect(kinds([
      page(),
      ...urls.map(url => on({
        method: 'POST',
        url,
        responseBody: jsonBody({}),
      })),
    ]).slice(1)).toEqual(urls.map(() => 'noise'))
    expect(kinds([
      page(),
      on({
        url: 'https://www.amazon.in/api/cart',
        responseBody: jsonBody({}),
      }),
    ])).toEqual(['page', 'api'])
  })
})

describe('classifyExchanges: challenge pages', () => {
  const doc = (url: string, html: string, status = 200): Exchange => on({
    url,
    resourceType: 'document',
    status,
    responseBody: textBody(html),
    pageUrl: null,
  })

  it('labels interstitials by title or challenge markup, whatever the status', () => {
    const result = classify([
      doc('https://shop.test/', '<html><head><title>Shop - Prove your humanity</title></head><body>…</body></html>'),
      doc('https://shop.test/r/news/', '<html><head><title>Shop</title><script>location.href = "?solution=1&js_challenge=1&jsc_token=" + t</script></head></html>'),
      doc('https://shop.test/r/news/?js_challenge=1', '<html><body><div>You\'ve been blocked by network security.</div></body></html>', 403),
      doc('https://shop.test/about', '<html><head><title>About us</title></head><body>We sell shoes.</body></html>'),
    ])
    expect(result.exchanges.map(item => item.kind)).toEqual([
      'bot-protection',
      'bot-protection',
      'bot-protection',
      'page',
    ])
    expect(result.exchanges[0]!.kindReason).toBe('Challenge page: challenge page (title "prove your humanity")')
    expect(result.botProtection.map(finding => [finding.vendor, finding.host, finding.evidence])).toEqual([
      ['Challenge page', 'shop.test', 'challenge page (JavaScript challenge redirect); challenge page (block page); challenge page (title "prove your humanity")'],
    ])
  })

  it('leaves ordinary pages that mention captchas or load a challenge script alone', () => {
    expect(kinds([
      doc('https://shop.test/login', '<html><head><title>Log in</title></head><body><div class="g-recaptcha" data-sitekey="k"></div></body></html>'),
      doc('https://shop.test/', '<html><head><title>Home</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head></html>'),
    ])).toEqual(['page', 'page'])
  })

  it('takes the AWS WAF challenge script for a challenge only on an interstitial', () => {
    const sdk = '<script src="https://a1b2c3d4.edge.sdk.awswaf.com/a1b2c3d4/e5f6/challenge.js" defer></script>'
    const app = `<html><head><title>Models - Example Hub</title>${sdk}</head><body><main>${'<article><h2>model-name</h2><p>A text model with a long description of what it does.</p></article>'.repeat(40)}</main></body></html>`
    const interstitial = `<html><head><title></title>${sdk}</head><body><div id="challenge-container"></div><noscript>Enable JavaScript</noscript></body></html>`
    expect(kinds([
      doc('https://hub.test/models', app),
      doc('https://hub.test/', interstitial, 202),
      doc('https://hub.test/spaces', interstitial),
      doc('https://hub.test/datasets', app, 405),
    ])).toEqual([
      'page',
      'bot-protection',
      'bot-protection',
      'bot-protection',
    ])
    expect(challengePageMarker(app)).toBeNull()
    expect(challengePageMarker(app, 200)).toBeNull()
    expect(challengePageMarker(interstitial, 202)).toBe('AWS WAF challenge')
    expect(challengePageMarker('<html><script>window.gokuProps = {}</script><body>big page</body></html>', 200)).toBe('AWS WAF challenge')
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
