import type { CaptureEvent, Exchange, HtmlLocator, LoadedSession, ValueTrace } from '../../model'
import type { TraceValuesInput } from './index'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { exchange, formBody, jsonBody, textBody } from '../../../test/helpers'
import { CLIENT_VERSION, CONSTANT_API_KEY, fakeHtmlLocator, ITEM_ID, shopCapture } from '../../../test/scenarios'
import { createHtmlLocator } from '../html'
import { traceValues } from './index'

const noLocator: HtmlLocator = () => null

function session(sessionId: string, events: CaptureEvent[] = []): LoadedSession {
  return {
    dir: `/captures/${sessionId}`,
    events,
    meta: {
      formatVersion: 1,
      sessionId,
      toolVersion: 'test',
      startUrl: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      browser: { channel: null, headless: true, userAgent: 'test' },
      har: 'traffic.har',
      events: 'events.jsonl',
      scripts: [],
    },
  }
}

function trace(exchanges: Exchange[], options: { sessions?: LoadedSession[], staticStrings?: string[], htmlLocator?: HtmlLocator } = {}): ValueTrace[] {
  const input: TraceValuesInput = {
    exchanges,
    sessions: options.sessions ?? [
      session('s1'),
    ],
    htmlLocator: options.htmlLocator ?? noLocator,
    staticStrings: new Set(options.staticStrings ?? []),
    minValueLength: 4,
  }
  return traceValues(input)
}

function originAt(traces: ValueTrace[], consumer: Exchange, key: string): ValueTrace['origin'] | undefined {
  return traces.find(entry => entry.exchangeId === consumer.id && JSON.stringify(entry.location) === key)?.origin
}

const TOKEN = 'tok_5f2c9a1e7b3d4c6a'

describe('traceValues: response producers', () => {
  it('links a JSON leaf to the query value of a later request', () => {
    const list = exchange({
      url: 'https://api.example.test/list',
      startedAt: 1,
      responseBody: jsonBody({
        rows: [
          { code: 'XQ-55-ALPHA' },
        ],
      }),
    })
    const detail = exchange({ url: 'https://api.example.test/detail?code=XQ-55-ALPHA', startedAt: 2 })
    expect(originAt(trace([list, detail]), detail, '{"in":"query","name":"code"}')).toEqual({
      kind: 'response',
      exchangeId: list.id,
      location: { in: 'body', pointer: '/rows/0/code' },
      transform: 'none',
    })
  })

  it('only looks at earlier exchanges of the same session', () => {
    const later = exchange({
      url: 'https://api.example.test/a',
      startedAt: 5,
      responseBody: jsonBody({ id: 'value-12345' }),
    })
    const otherSession = exchange({
      url: 'https://api.example.test/b',
      sessionId: 's2',
      startedAt: 1,
      responseBody: jsonBody({ id: 'value-12345' }),
    })
    const consumer = exchange({ url: 'https://api.example.test/c?id=value-12345', startedAt: 3 })
    expect(originAt(trace([later, otherSession, consumer], {
      sessions: [
        session('s1'),
      ],
    }), consumer, '{"in":"query","name":"id"}')?.kind).toBe('unknown')
  })

  it('picks the earliest producer, and an exact match over an earlier encoded one', () => {
    const encoded = exchange({
      url: 'https://api.example.test/1',
      startedAt: 1,
      responseBody: jsonBody({
        v: Buffer.from('needle-value').toString('base64'),
      }),
    })
    const exactFirst = exchange({
      url: 'https://api.example.test/2',
      startedAt: 2,
      responseBody: jsonBody({ first: 'needle-value' }),
    })
    const exactSecond = exchange({
      url: 'https://api.example.test/3',
      startedAt: 3,
      responseBody: jsonBody({ second: 'needle-value' }),
    })
    const consumer = exchange({ url: 'https://api.example.test/4?q=needle-value', startedAt: 4 })
    const origin = originAt(trace([
      encoded,
      exactFirst,
      exactSecond,
      consumer,
    ]), consumer, '{"in":"query","name":"q"}')
    expect(origin).toMatchObject({ kind: 'response', exchangeId: exactFirst.id, transform: 'none' })
  })

  it('prefers the Set-Cookie of the same name over an earlier body value', () => {
    const body = exchange({
      url: 'https://api.example.test/1',
      startedAt: 1,
      responseBody: jsonBody({ blob: 'c00kie-value-xyz' }),
    })
    const cookie = exchange({
      url: 'https://api.example.test/2',
      startedAt: 2,
      setCookies: { sid: 'c00kie-value-xyz' },
    })
    const consumer = exchange({
      url: 'https://api.example.test/3',
      startedAt: 3,
      cookies: { sid: 'c00kie-value-xyz' },
    })
    expect(originAt(trace([body, cookie, consumer]), consumer, '{"in":"cookie","name":"sid"}')).toMatchObject({
      exchangeId: cookie.id,
      location: { in: 'set-cookie', name: 'sid' },
    })
  })

  it.each([
    [
      'url-encoded',
      'a b/c+d=e',
      encodeURIComponent('a b/c+d=e'),
    ],
    [
      'url-encoded (decoded in request)',
      encodeURIComponent('x y/z+w=v'),
      'x y/z+w=v',
    ],
    [
      'base64 of the response value',
      'plain-value-1',
      Buffer.from('plain-value-1').toString('base64'),
    ],
    [
      'base64 decoded from the response',
      Buffer.from('decoded-value-2').toString('base64'),
      'decoded-value-2',
    ],
    [
      'json-string escaped',
      'line "one"\nline two',
      JSON.stringify('line "one"\nline two').slice(1, -1),
    ],
  ])('matches %s values', (_label, produced, sent) => {
    const producer = exchange({
      url: 'https://api.example.test/p',
      startedAt: 1,
      responseBody: jsonBody({ value: produced }),
    })
    const consumer = exchange({
      method: 'POST',
      url: 'https://api.example.test/c',
      startedAt: 2,
      requestBody: jsonBody({ value: sent }),
    })
    const origin = originAt(trace([producer, consumer]), consumer, '{"in":"body","pointer":"/value"}')
    const expected = _label.startsWith('url')
      ? 'url-encoded'
      : _label.startsWith('base64')
        ? 'base64'
        : 'json-string'
    expect(origin).toMatchObject({ kind: 'response', exchangeId: producer.id, transform: expected })
  })

  it('matches a token inside a longer value as a substring', () => {
    const login = exchange({
      url: 'https://api.example.test/login',
      startedAt: 1,
      responseBody: jsonBody({ token: TOKEN }),
    })
    const call = exchange({
      url: 'https://api.example.test/me',
      startedAt: 2,
      requestHeaders: { authorization: `Bearer ${TOKEN}` },
    })
    expect(originAt(trace([login, call]), call, '{"in":"header","name":"authorization"}')).toEqual({
      kind: 'response',
      exchangeId: login.id,
      location: { in: 'body', pointer: '/token' },
      transform: 'substring',
    })
  })

  it('does not match a plain word inside a longer response text as a substring', () => {
    const copy = exchange({
      url: 'https://api.example.test/i18n',
      startedAt: 1,
      responseBody: jsonBody({ desc: 'Prices from both markets, combined into one feed' }),
    })
    const call = exchange({ url: 'https://api.example.test/feed?view=combined', startedAt: 2 })
    expect(originAt(trace([copy, call]), call, '{"in":"query","name":"view"}')).toMatchObject({ kind: 'unknown' })
  })

  it('finds values in HTML through the locator, also as part of a longer value', () => {
    const page = exchange({
      url: 'https://www.example.test/',
      startedAt: 1,
      kind: 'page',
      responseBody: textBody('<meta name="csrf" content="csrf-token-abcdef123">'),
    })
    const post = exchange({
      method: 'POST',
      url: 'https://www.example.test/save',
      startedAt: 2,
      requestHeaders: { 'x-csrf': 'csrf-token-abcdef123', 'x-auth': 'Token csrf-token-abcdef123' },
    })
    const traces = trace([page, post], { htmlLocator: fakeHtmlLocator })
    expect(originAt(traces, post, '{"in":"header","name":"x-csrf"}')).toEqual({
      kind: 'response',
      exchangeId: page.id,
      location: {
        in: 'html',
        selector: 'meta[name="csrf"]',
        attr: 'content',
        pattern: null,
      },
      transform: 'none',
    })
    expect(originAt(traces, post, '{"in":"header","name":"x-auth"}')).toMatchObject({
      transform: 'substring',
      location: { in: 'html' },
    })
  })

  it('records no HTML origin when the locator cannot place the value', () => {
    const page = exchange({
      url: 'https://www.example.test/',
      startedAt: 1,
      kind: 'page',
      responseBody: textBody('<script>window.k="inline-key-998877"</script>'),
    })
    const call = exchange({ url: 'https://www.example.test/api?k=inline-key-998877', startedAt: 2 })
    expect(originAt(trace([page, call]), call, '{"in":"query","name":"k"}')).toMatchObject({ kind: 'unknown' })
  })

  it('does not trace a plain word to a page that only contains it somewhere', () => {
    const page = exchange({
      url: 'https://www.example.test/',
      startedAt: 1,
      kind: 'page',
      responseBody: textBody('<html><body><script>var mode="combined";</script><div class="bar-horizontal">Live ticks</div></body></html>'),
    })
    const call = exchange({ url: 'https://www.example.test/api?view=combined&op=tick&dir=horizontal', startedAt: 2 })
    for (const htmlLocator of [
      noLocator,
      createHtmlLocator(),
    ]) {
      const traces = trace([page, call], { htmlLocator })
      for (const name of ['view', 'op', 'dir'])
        expect(originAt(traces, call, `{"in":"query","name":"${name}"}`)).toMatchObject({ kind: 'unknown' })
    }
  })

  it('still traces a plain word to the page element that holds exactly it', () => {
    const page = exchange({
      url: 'https://www.example.test/',
      startedAt: 1,
      kind: 'page',
      responseBody: textBody('<html><body><select><option value="combined" selected>Combined</option></select></body></html>'),
    })
    const call = exchange({ url: 'https://www.example.test/api?view=combined', startedAt: 2 })
    expect(originAt(trace([page, call], {
      htmlLocator: createHtmlLocator(),
    }), call, '{"in":"query","name":"view"}')).toMatchObject({
      kind: 'response',
      location: { in: 'html', attr: 'value' },
    })
  })

  it('does not trace a short number to a page that contains it by chance', () => {
    const page = exchange({
      url: 'https://www.example.test/',
      startedAt: 1,
      kind: 'page',
      responseBody: textBody('<meta name="viewport" content="width=device-width, initial-scale=1"><p>Welcome</p>'),
    })
    // One JSON response returned `1`, so the small-integer rule lets `page=1` be traced at all.
    const meta = exchange({
      url: 'https://api.example.test/meta',
      startedAt: 2,
      responseBody: jsonBody({ firstPage: 1 }),
    })
    const list = exchange({ url: 'https://api.example.test/products?page=1', startedAt: 3 })
    const origin = originAt(trace([page, meta, list], {
      htmlLocator: createHtmlLocator(),
    }), list, '{"in":"query","name":"page"}')
    expect(origin).toEqual({
      kind: 'response',
      exchangeId: meta.id,
      location: { in: 'body', pointer: '/firstPage' },
      transform: 'none',
    })
  })

  it('still traces a value of the minimum length to the page attribute it came from', () => {
    const page = exchange({
      url: 'https://www.example.test/stores',
      startedAt: 1,
      kind: 'page',
      responseBody: textBody('<ul id="stores"><li><a href="/s/north" data-store="nrth">North</a></li></ul>'),
    })
    const call = exchange({ url: 'https://api.example.test/stock?store=nrth', startedAt: 2 })
    expect(originAt(trace([page, call], {
      htmlLocator: createHtmlLocator(),
    }), call, '{"in":"query","name":"store"}')).toMatchObject({
      kind: 'response',
      exchangeId: page.id,
      location: { in: 'html', attr: 'data-store', pattern: null },
      transform: 'none',
    })
  })

  it('reads form fields and path segments', () => {
    const list = exchange({
      url: 'https://api.example.test/orders',
      startedAt: 1,
      responseBody: jsonBody([
        { id: 'ORD-99812' },
      ]),
    })
    const detail = exchange({ url: 'https://api.example.test/orders/ORD-99812', startedAt: 2 })
    const form = exchange({
      method: 'POST',
      url: 'https://api.example.test/cancel',
      startedAt: 3,
      requestBody: formBody({ order: 'ORD-99812' }),
    })
    const traces = trace([list, detail, form])
    expect(originAt(traces, detail, '{"in":"path","index":1}')).toMatchObject({
      location: { in: 'body', pointer: '/0/id' },
    })
    expect(originAt(traces, form, '{"in":"form","name":"order"}')).toMatchObject({ exchangeId: list.id })
  })
})

describe('traceValues: trivial values', () => {
  it('skips short values, booleans, common words, browser headers and route words', () => {
    const producer = exchange({
      url: 'https://api.example.test/p',
      startedAt: 1,
      responseBody: jsonBody({ a: 'abc', b: 'search', c: 'en-US' }),
    })
    const consumer = exchange({
      method: 'POST',
      url: 'https://api.example.test/api/items?x=abc&mode=search',
      startedAt: 2,
      requestHeaders: { 'accept-language': 'en-US', 'user-agent': 'Mozilla/5.0 test', 'sec-ch-ua': '"Chromium"' },
      requestBody: jsonBody({ flag: true, none: null }),
    })
    expect(trace([producer, consumer]).filter(entry => entry.exchangeId === consumer.id)).toEqual([])
  })

  it('ignores values equal to the request host or its own path pieces', () => {
    const consumer = exchange({ url: 'https://api.example.test/v2/ORD-1234?host=api.example.test&again=ORD-1234', startedAt: 1 })
    const keys = trace([consumer]).map(entry => JSON.stringify(entry.location))
    expect(keys).toEqual(['{"in":"path","index":1}'])
  })

  it('traces a small integer only when exactly one response returned it', () => {
    const unique = exchange({
      url: 'https://api.example.test/a',
      startedAt: 1,
      responseBody: jsonBody({ shopId: 42 }),
    })
    const consumer = exchange({ url: 'https://api.example.test/b?shop=42&page=2', startedAt: 2 })
    const traces = trace([unique, consumer])
    expect(traces.map(entry => entry.value)).toEqual(['42'])

    const twice = exchange({
      url: 'https://api.example.test/c',
      sessionId: 's2',
      startedAt: 1,
      responseBody: jsonBody({ a: 42, b: 42 }),
    })
    const consumer2 = exchange({ url: 'https://api.example.test/d?shop=42', sessionId: 's2', startedAt: 2 })
    expect(trace([twice, consumer2], {
      sessions: [
        session('s2'),
      ],
    })).toEqual([])
  })
})

describe('traceValues: values no response produced', () => {
  it('uses the transform event whose output equals the value', () => {
    const events: CaptureEvent[] = [
      {
        t: 'transform',
        ts: 50,
        pageUrl: 'https://x.example.test/',
        api: 'btoa',
        output: ['ZW5jb2RlZC12YWx1ZQ=='],
        inputs: ['encoded-value'],
        details: null,
        stack: [],
      },
      {
        t: 'transform',
        ts: 500,
        pageUrl: 'https://x.example.test/',
        api: 'btoa',
        output: ['ZW5jb2RlZC12YWx1ZQ=='],
        inputs: ['encoded-value'],
        details: null,
        stack: [],
      },
    ]
    const consumer = exchange({
      method: 'POST',
      url: 'https://x.example.test/api',
      startedAt: 100,
      requestBody: jsonBody({ blob: 'ZW5jb2RlZC12YWx1ZQ==' }),
    })
    expect(trace([consumer], {
      sessions: [
        session('s1', events),
      ],
    })[0]?.origin).toEqual({ kind: 'transform', eventIndex: 0, sessionId: 's1' })
  })

  it('marks a value typed into a field of the same name as user input', () => {
    const events: CaptureEvent[] = [
      {
        t: 'action',
        ts: 10,
        pageUrl: 'https://x.example.test/',
        kind: 'change',
        label: 'Search',
        selector: 'input[name="query"]',
        field: null,
      },
    ]
    const consumer = exchange({ url: 'https://x.example.test/api/search?query=blue%20mugs', startedAt: 20 })
    expect(trace([consumer], {
      sessions: [
        session('s1', events),
      ],
    })[0]?.origin).toEqual({ kind: 'user-input', field: 'query' })
  })

  it('does not credit typing that happened after the request', () => {
    const events: CaptureEvent[] = [
      {
        t: 'action',
        ts: 30,
        pageUrl: 'https://x.example.test/',
        kind: 'change',
        label: 'Search',
        selector: '#query',
        field: 'query',
      },
    ]
    const consumer = exchange({ url: 'https://x.example.test/api/search?query=blue%20mugs', startedAt: 20 })
    expect(trace([consumer], {
      sessions: [
        session('s1', events),
      ],
    })[0]?.origin.kind).toBe('unknown')
  })

  it('treats script literals and values identical in every session as constants', () => {
    const first = exchange({ url: 'https://x.example.test/api?v=release-77&lit=from-the-bundle', sessionId: 'one', startedAt: 1 })
    const second = exchange({ url: 'https://x.example.test/api?v=release-77&lit=other-value', sessionId: 'two', startedAt: 1 })
    const traces = trace([first, second], {
      sessions: [
        session('one'),
        session('two'),
      ],
      staticStrings: ['from-the-bundle'],
    })
    expect(traces.map(entry => [entry.exchangeId, entry.value, entry.origin.kind])).toEqual([
      [first.id, 'release-77', 'constant'],
      [first.id, 'from-the-bundle', 'constant'],
      [second.id, 'release-77', 'constant'],
      [second.id, 'other-value', 'unknown'],
    ])
  })

  it('says a cookie no response set came from a page script, naming the vendor', () => {
    const consumer = exchange({
      url: 'https://x.example.test/api',
      startedAt: 1,
      cookies: { _abck: 'abck-value-123456', prefs: 'dark-mode-yes' },
    })
    expect(trace([consumer]).map(entry => entry.origin)).toEqual([
      { kind: 'browser', note: 'set by page script (Akamai Bot Manager)' },
      { kind: 'browser', note: 'set by page script' },
    ])
  })
})

describe('traceValues: shop scenario', () => {
  const capture = shopCapture()
  const traces = traceValues({
    exchanges: capture.exchanges,
    sessions: capture.sessions.map(entry => entry.session),
    htmlLocator: fakeHtmlLocator,
    staticStrings: new Set(),
    minValueLength: 4,
  })
  const a = capture.sessions[0]!.named

  it('traces every dependency of the sign-in request', () => {
    const at = (key: string): ValueTrace['origin'] | undefined => originAt(traces, a.login, key)
    expect(at('{"in":"header","name":"x-csrf-token"}')).toMatchObject({
      exchangeId: a.loginPage.id,
      location: { in: 'html', selector: 'meta[name="csrf-token"]' },
    })
    expect(at('{"in":"cookie","name":"session"}')).toMatchObject({
      exchangeId: a.loginPage.id,
      location: { in: 'set-cookie', name: 'session' },
    })
    expect(at('{"in":"cookie","name":"_abck"}')).toEqual({ kind: 'browser', note: 'set by page script (Akamai Bot Manager)' })
    expect(at('{"in":"body","pointer":"/username"}')).toEqual({ kind: 'user-input', field: 'username' })
    expect(at('{"in":"body","pointer":"/password"}')).toEqual({ kind: 'transform', eventIndex: 2, sessionId: 'a' })
    expect(at('{"in":"header","name":"x-client-version"}')).toEqual({ kind: 'constant' })
    expect(traces.find(entry => entry.value === CLIENT_VERSION)?.origin.kind).toBe('constant')
    expect(traces.find(entry => entry.value === CONSTANT_API_KEY)?.origin.kind).toBe('constant')
  })

  it('traces the item id from the list into the detail path', () => {
    expect(originAt(traces, a.item, '{"in":"path","index":2}')).toEqual({
      kind: 'response',
      exchangeId: a.items.id,
      location: { in: 'body', pointer: '/items/0/id' },
      transform: 'none',
    })
    expect(traces.filter(entry => entry.value === ITEM_ID)).toHaveLength(2)
  })

  it('is deterministic and independent of input order', () => {
    const shuffled = traceValues({
      exchanges: [...capture.exchanges].reverse(),
      sessions: capture.sessions.map(entry => entry.session).reverse(),
      htmlLocator: fakeHtmlLocator,
      staticStrings: new Set(),
      minValueLength: 4,
    })
    expect(shuffled).toEqual(traces)
  })
})
