import type { ResolvedConfig } from '../../config/schema'
import type { CaptureEvent, Exchange, FlowsDocument, LoadedSession, Operation, Redactor, ValueTrace } from '../../model'
import type { BuildFlowsInput } from './index'
import { describe, expect, it } from 'vitest'
import { exchange, formBody, jsonBody } from '../../../test/helpers'
import { CLIENT_VERSION, CONSTANT_API_KEY, fakeHtmlLocator, fakeSourceResolver, HOST, SECRET_VALUES, shopCapture } from '../../../test/scenarios'
import { FlowsDocumentSchema } from '../../model'
import { traceValues } from '../correlate'
import { createRedactor } from '../redact'
import { buildFlows } from './index'

/** The default redaction settings (`redact.examples: masked`). */
const REDACT: ResolvedConfig['redact'] = {
  examples: 'masked',
  maxExamples: 3,
  patterns: [],
  fields: [],
}

function redactorFor(exchanges: Exchange[], config: Partial<ResolvedConfig['redact']> = {}): Redactor {
  return createRedactor({
    exchanges,
    config: {
      ...REDACT,
      ...config,
    },
  })
}

function shopFlows(capture = shopCapture(), reverse = false): { doc: FlowsDocument, capture: ReturnType<typeof shopCapture> } {
  const order = <T>(items: T[]): T[] => (reverse
    ? [...items].reverse()
    : items)
  const sessions = order(capture.sessions.map(entry => entry.session))
  const exchanges = order(capture.exchanges)
  const traces = traceValues({
    exchanges,
    sessions,
    htmlLocator: fakeHtmlLocator,
    staticStrings: new Set(),
    minValueLength: 4,
  })
  const doc = buildFlows({
    exchanges,
    operations: order(capture.operations),
    sessions,
    traces,
    sourceResolver: fakeSourceResolver,
    botProtection: capture.botProtection,
    redactor: redactorFor(exchanges),
    toolVersion: '1.2.3',
  })
  return { doc, capture }
}

function flow(doc: FlowsDocument, id: string): FlowsDocument['flows'][number] {
  const found = doc.flows.find(entry => entry.id === id)
  if (!found)
    throw new Error(`no flow ${id}; have ${doc.flows.map(entry => entry.id).join(', ')}`)
  return found
}

describe('buildFlows: shop scenario', () => {
  const { doc, capture } = shopFlows()

  it('produces a valid document', () => {
    expect(FlowsDocumentSchema.safeParse(doc).success).toBe(true)
    expect(doc.formatVersion).toBe(1)
    expect(doc.generatedBy).toBe('site-to-api 1.2.3')
    expect(doc.sessions).toEqual(['a', 'b'])
  })

  it('splits the timeline at actions, folding the navigation a submit caused', () => {
    expect(doc.flows.map(entry => [entry.id, entry.trigger.kind, entry.name])).toEqual([
      ['load-login', 'load', 'Load /login'],
      ['sign-in', 'submit', 'Sign in'],
      ['blue-mug', 'click', 'Blue mug'],
    ])
    expect(flow(doc, 'load-login').steps.map(step => step.operationId)).toEqual(['getLogin', 'postAkamPixel', 'getApiConfig'])
    expect(flow(doc, 'sign-in').steps.map(step => step.operationId)).toEqual(['postApiLogin', 'getApiItems', 'getApiNotifications'])
    expect(flow(doc, 'blue-mug').steps.map(step => step.operationId)).toEqual(['getApiItemsId'])
  })

  it('strips the query from trigger page URLs, which can carry tokens', () => {
    expect(flow(doc, 'load-login').trigger.pageUrl).toBe(`https://${HOST}/login`)
  })

  it('merges flows seen in both sessions', () => {
    expect(doc.flows.map(entry => entry.seenInSessions)).toEqual([2, 2, 2])
    const [a, b] = capture.sessions
    expect(flow(doc, 'blue-mug').steps[0]?.observedIn).toEqual([a!.named.item.id, b!.named.item.id])
  })

  it('folds repeated polling into one step', () => {
    const [a, b] = capture.sessions
    const poll = flow(doc, 'sign-in').steps[2]
    expect(poll?.observedIn).toEqual([
      a!.named.pollA.id,
      a!.named.pollB.id,
      b!.named.pollA.id,
      b!.named.pollB.id,
    ])
  })

  it('marks bot-protection steps browser-only', () => {
    const steps = flow(doc, 'load-login').steps
    expect(steps.map(step => step.browserOnly)).toEqual([false, true, false])
    expect(steps[1]?.kind).toBe('bot-protection')
  })

  it('describes where each sign-in input came from', () => {
    const login = flow(doc, 'sign-in').steps[0]!
    expect(login.inputs).toEqual({
      'header.x-client-version': { kind: 'constant', value: CLIENT_VERSION },
      // Secret-named but identical in both sessions: kept, as the redactor and the specs keep it.
      'header.x-api-key': { kind: 'constant', value: CONSTANT_API_KEY },
      'header.x-csrf-token': {
        kind: 'html',
        step: 'load-login.s1',
        selector: 'meta[name="csrf-token"]',
        attr: 'content',
        pattern: null,
        confidence: 'high',
      },
      'cookie.session': {
        kind: 'step',
        step: 'load-login.s1',
        output: 'set-cookie.session',
        transform: 'none',
      },
      'cookie._abck': { kind: 'browser', note: 'set by page script (Akamai Bot Manager)' },
      'body./username': { kind: 'user-input', field: 'username' },
      'body./password': { kind: 'computed', computedId: 'postapilogin-body-password' },
    })
    expect(login.summary).toBe('After submitting "Sign in": Sign in with email and password')
    expect(login.sentFrom).toMatchObject({ file: 'src/submitLogin.ts', line: 42, functionName: 'submitLogin' })
  })

  it('links a token from the login response into a later Authorization header', () => {
    const items = flow(doc, 'sign-in').steps[1]!
    expect(items.inputs['header.authorization']).toEqual({
      kind: 'step',
      step: 's1',
      output: 'body./token',
      transform: 'substring',
    })
  })

  it('links an id from the list response into a later path, across flows', () => {
    const item = flow(doc, 'blue-mug').steps[0]!
    expect(item.inputs['path.2']).toEqual({
      kind: 'step',
      step: 'sign-in.s2',
      // Any element: the sample's index (0) is not part of how the API works.
      output: 'body./items/*/id',
      transform: 'none',
    })
  })

  it('lists only the outputs later steps use, with readable names', () => {
    const [page, sensor, config] = flow(doc, 'load-login').steps
    expect(page?.outputs).toEqual({ 'cookie.session': 'set-cookie.session', 'csrf-token': 'html.meta[name="csrf-token"]@content' })
    expect(sensor?.outputs).toEqual({})
    expect(config?.outputs).toEqual({ publicKey: 'body./publicKey' })
    const [login, items, poll] = flow(doc, 'sign-in').steps
    expect(login?.outputs).toEqual({ token: 'body./token' })
    expect(items?.outputs).toEqual({ id: 'body./items/*/id' })
    expect(poll?.outputs).toEqual({})
  })

  it('records the computed password with the code that produced it', () => {
    expect(doc.computedValues).toEqual([
      {
        id: 'postapilogin-body-password',
        operationId: 'postApiLogin',
        input: 'body./password',
        producedBy: {
          file: 'src/encryptPassword.ts',
          line: 300,
          column: 7,
          functionName: 'encryptPassword',
          original: true,
          excerpt: null,
        },
        calledFrom: {
          file: 'src/submitLogin.ts',
          line: 42,
          column: 7,
          functionName: 'submitLogin',
          original: true,
          excerpt: null,
        },
        api: 'JSEncrypt.encrypt',
        details: { padding: 'pkcs1' },
        // The key from a response and the password the person typed (the field, never its value).
        uses: [
          { kind: 'user-input', field: 'password' },
          {
            kind: 'step',
            step: 'load-login.s3',
            output: 'body./publicKey',
            transform: 'none',
          },
        ],
        evidence: 'transform-hook',
      },
    ])
  })

  it('derives session requirements per host', () => {
    expect(doc.session).toEqual([
      {
        host: HOST,
        requires: 'browser',
        cookies: [
          { name: '_abck', setBy: null, source: 'browser' },
          { name: 'session', setBy: 'getLogin', source: 'response' },
        ],
        botProtection: [
          { vendor: 'Akamai', evidence: '/akam/ sensor endpoint and _abck cookie' },
        ],
        probed: false,
      },
    ])
  })

  it('never contains a secret value', () => {
    const json = JSON.stringify(doc)
    for (const secret of SECRET_VALUES)
      expect(json).not.toContain(secret)
  })

  it('is deterministic, whatever order the inputs come in', () => {
    expect(JSON.stringify(shopFlows(capture).doc)).toBe(JSON.stringify(doc))
    expect(JSON.stringify(shopFlows(capture, true).doc)).toBe(JSON.stringify(doc))
  })
})

function loaded(sessionId: string, events: CaptureEvent[], startUrl: string | null = null): LoadedSession {
  return {
    dir: `/captures/${sessionId}`,
    events,
    meta: {
      formatVersion: 1,
      sessionId,
      toolVersion: 'test',
      startUrl,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      browser: { channel: null, headless: true, userAgent: 'test' },
      har: 'traffic.har',
      events: 'events.jsonl',
      scripts: [],
    },
  }
}

function op(operationId: string, exchanges: Exchange[], overrides: Partial<Operation> = {}): Operation {
  const first = exchanges[0]
  return {
    operationId,
    host: first?.request.host ?? 'api.example.test',
    method: first?.request.method ?? 'GET',
    path: first?.request.path ?? '/',
    kind: 'api',
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses: [],
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges,
    ...overrides,
  }
}

function build(exchanges: Exchange[], operations: Operation[], sessions: LoadedSession[], traces: ValueTrace[] = []): FlowsDocument {
  const input: BuildFlowsInput = {
    exchanges,
    operations,
    sessions,
    traces,
    sourceResolver: fakeSourceResolver,
    botProtection: [],
    redactor: redactorFor(exchanges),
    toolVersion: 'test',
  }
  return buildFlows(input)
}

describe('buildFlows: segments and merging', () => {
  it('does not merge flows whose operation sequences differ, and keeps ids unique', () => {
    const one = exchange({ url: 'https://api.example.test/one', sessionId: 'x', startedAt: 10 })
    const two = exchange({ url: 'https://api.example.test/two', sessionId: 'y', startedAt: 10 })
    const click: CaptureEvent[] = [
      {
        t: 'action',
        ts: 5,
        pageUrl: 'https://www.example.test/',
        kind: 'click',
        label: 'Go!',
        selector: 'button',
        field: null,
      },
    ]
    const doc = build([one, two], [
      op('getOne', [one]),
      op('getTwo', [two]),
    ], [
      loaded('x', click),
      loaded('y', click),
    ])
    expect(doc.flows.map(entry => [entry.id, entry.seenInSessions])).toEqual([
      ['go', 1],
      ['go-2', 1],
    ])
    expect(doc.flows[0]?.steps[0]?.summary).toBe('After clicking "Go!": GET /one.')
  })

  it('starts a navigation at its document request, which comes before the navigate event', () => {
    const newest = exchange({
      url: 'https://news.example.test/newest',
      resourceType: 'document',
      kind: 'page',
      startedAt: 1_100,
    })
    const search = exchange({
      url: 'https://search.example.test/',
      resourceType: 'document',
      kind: 'page',
      startedAt: 4_000,
    })
    const query = exchange({ url: 'https://api.search.example.test/query', startedAt: 4_600 })
    const action = (ts: number, kind: 'click' | 'navigate', pageUrl: string, label: string): CaptureEvent => ({
      t: 'action',
      ts,
      pageUrl,
      kind,
      label,
      selector: kind === 'click'
        ? 'a'
        : '',
      field: null,
    })
    const doc = build([newest, search, query], [
      op('getNewest', [newest], { kind: 'page' }),
      op('getRoot', [search], { kind: 'page' }),
      op('getQuery', [query]),
    ], [
      loaded('s1', [
        action(1_000, 'click', 'https://news.example.test/', 'new'),
        action(1_500, 'navigate', 'https://news.example.test/newest', 'Newest'),
        // A script's `page.goto`: the event arrives once the page runs, after its document.
        action(4_400, 'navigate', 'https://search.example.test/', 'Search'),
      ]),
    ])
    expect(doc.flows.map(entry => [
      entry.trigger.kind,
      entry.steps.map(step => step.operationId),
    ])).toEqual([
      [
        'click',
        ['getNewest'],
      ],
      [
        'navigate',
        ['getRoot', 'getQuery'],
      ],
    ])
  })

  it('drops segments without steps and skips exchanges without an operation or of other kinds', () => {
    const asset = exchange({ url: 'https://cdn.example.test/app.js', startedAt: 1, kind: 'asset' })
    const orphan = exchange({ url: 'https://api.example.test/orphan', startedAt: 2 })
    const call = exchange({ url: 'https://api.example.test/data', startedAt: 20 })
    const events: CaptureEvent[] = [
      {
        t: 'action',
        ts: 10,
        pageUrl: 'https://www.example.test/',
        kind: 'navigate',
        label: 'Data page',
        selector: '',
        field: null,
      },
    ]
    const doc = build([asset, orphan, call], [
      op('getData', [call]),
      op('getApp', [asset]),
    ], [
      loaded('s1', events),
    ])
    expect(doc.flows.map(entry => entry.id)).toEqual(['data-page'])
    expect(doc.flows[0]?.steps.map(step => step.operationId)).toEqual(['getData'])
  })

  it('keeps distinct calls to one operation as separate steps', () => {
    const first = exchange({ url: 'https://api.example.test/items/AAA-111', startedAt: 1 })
    const second = exchange({ url: 'https://api.example.test/items/BBB-222', startedAt: 2 })
    const doc = build([first, second], [
      op('getItem', [first, second]),
    ], [
      loaded('s1', [], 'https://www.example.test/shop?ref=mail'),
    ])
    expect(doc.flows[0]?.name).toBe('Load /shop')
    expect(doc.flows[0]?.steps.map(step => step.observedIn)).toEqual([
      [first.id],
      [second.id],
    ])
  })

  it('writes a constant that looks like a credential as a shape, and an unresolvable producer as unknown', () => {
    const call = exchange({
      url: 'https://api.example.test/data?release=web-2026-10',
      startedAt: 5,
      requestHeaders: { authorization: 'Basic c2hhcmVkOnNoYXJlZA==' },
    })
    const traces: ValueTrace[] = [
      {
        exchangeId: call.id,
        location: { in: 'header', name: 'authorization' },
        value: 'Basic c2hhcmVkOnNoYXJlZA==',
        origin: { kind: 'constant' },
      },
      {
        exchangeId: call.id,
        location: { in: 'query', name: 'release' },
        value: 'web-2026-10',
        origin: {
          kind: 'response',
          exchangeId: 'nowhere:1',
          location: { in: 'body', pointer: '/r' },
          transform: 'none',
        },
      },
    ]
    const doc = build([call], [
      op('getData', [call]),
    ], [
      loaded('s1', []),
    ], traces)
    expect(doc.flows[0]?.steps[0]?.inputs).toEqual({
      'header.authorization': { kind: 'unknown', shape: '26 chars, separators " "' },
      'query.release': { kind: 'unknown', shape: '11 chars' },
    })
  })

  it('writes an HTML origin only when it reads the value sent, and rates a regex over prose low', () => {
    const page = exchange({ url: 'https://www.example.test/', startedAt: 1, kind: 'page' })
    const call = exchange({
      url: 'https://www.example.test/api?a=1&b=2&c=3',
      startedAt: 5,
      requestHeaders: { 'x-auth': 'Token k-77a1b2c3d4' },
    })
    const html = (selector: string, pattern: string | null): ValueTrace['origin'] => ({
      kind: 'response',
      exchangeId: page.id,
      location: {
        in: 'html',
        selector,
        attr: null,
        pattern,
      },
      transform: 'none',
    })
    const traces: ValueTrace[] = [
      // The header holds the page value inside a longer string: the origin would read only a part.
      {
        exchangeId: call.id,
        location: { in: 'header', name: 'x-auth' },
        value: 'Token k-77a1b2c3d4',
        origin: {
          kind: 'response',
          exchangeId: page.id,
          location: {
            in: 'html',
            selector: 'meta',
            attr: 'content',
            pattern: null,
          },
          transform: 'substring',
        },
      },
      {
        exchangeId: call.id,
        location: { in: 'query', name: 'a' },
        value: 'k-77a1b2c3d4',
        origin: html('body > script:nth-of-type(2)', 'key:"([^"]*)'),
      },
      {
        exchangeId: call.id,
        location: { in: 'query', name: 'b' },
        value: 'k-77a1b2c3d4',
        origin: html('h1', 'for ([\\w-]+)'),
      },
      {
        exchangeId: call.id,
        location: { in: 'query', name: 'c' },
        value: 'k-77a1b2c3d4',
        origin: html('', 'id=([\\w-]+)'),
      },
    ]
    const doc = build([page, call], [
      op('getRoot', [page]),
      op('getApi', [call]),
    ], [
      loaded('s1', []),
    ], traces)
    const inputs = doc.flows[0]?.steps.find(entry => entry.operationId === 'getApi')?.inputs
    expect(inputs?.['header.x-auth']).toMatchObject({ kind: 'unknown' })
    expect(inputs?.['query.a']).toMatchObject({ kind: 'html', confidence: 'high' })
    expect(inputs?.['query.b']).toMatchObject({ kind: 'html', confidence: 'low' })
    expect(inputs?.['query.c']).toMatchObject({ kind: 'html', confidence: 'low' })
  })

  it('needs a token when an API sends Authorization, cookies when it sends cookies, nothing otherwise', () => {
    const withToken = exchange({
      url: 'https://token.example.test/a',
      startedAt: 1,
      requestHeaders: { authorization: 'Bearer x' },
    })
    const withCookie = exchange({
      url: 'https://cookie.example.test/a',
      startedAt: 2,
      cookies: { sid: 'x', _ga: 'GA1.1' },
    })
    const plain = exchange({
      url: 'https://plain.example.test/a',
      startedAt: 3,
      responseBody: jsonBody({}),
    })
    const operations = [
      op('a', [withToken], {
        headers: [
          {
            name: 'authorization',
            required: true,
            schema: {},
            constant: false,
          },
        ],
      }),
      op('b', [withCookie], {
        cookies: [
          { name: 'sid', required: true, schema: {} },
          { name: '_ga', required: false, schema: {} },
        ],
      }),
      op('c', [plain]),
    ]
    const doc = build([withToken, withCookie, plain], operations, [
      loaded('s1', []),
    ])
    expect(doc.session.map(entry => [
      entry.host,
      entry.requires,
      entry.cookies.map(cookie => `${cookie.name}:${cookie.source}`),
    ])).toEqual([
      [
        'cookie.example.test',
        'cookies',
        // Too short to trace and set by no response: present in the profile, origin unknown.
        ['sid:unknown'],
      ],
      ['plain.example.test', 'none', []],
      ['token.example.test', 'token', []],
    ])
  })
})

describe('buildFlows: cookies set by page scripts', () => {
  function sessionOf(cookies: Record<string, string>): FlowsDocument['session'][number] | undefined {
    const config = exchange({
      url: 'https://script.example.test/api/config',
      startedAt: 1,
      responseBody: jsonBody({ defaultStore: 'pine-hill' }),
    })
    const call = exchange({
      url: 'https://script.example.test/api/stock',
      startedAt: 2,
      cookies,
      responseBody: jsonBody({ ok: true }),
    })
    const exchanges = [config, call]
    const sessions = [
      loaded('s1', []),
    ]
    const traces = traceValues({
      exchanges,
      sessions,
      htmlLocator: fakeHtmlLocator,
      staticStrings: new Set(),
      minValueLength: 4,
    })
    const operations = [
      op('getApiConfig', [config]),
      op('getApiStock', [call], {
        cookies: Object.keys(cookies).map(name => ({ name, required: true, schema: {} })),
      }),
    ]
    return build(exchanges, operations, sessions, traces).session[0]
  }

  it('marks a cookie whose value a response provides as script-set, needing no browser', () => {
    const session = sessionOf({ store: 'pine-hill' })
    expect(session?.cookies).toEqual([
      { name: 'store', setBy: null, source: 'script' },
    ])
    expect(session?.requires).toBe('cookies')
  })

  it('needs a browser for opaque or bot-protection cookies', () => {
    const opaque = sessionOf({ store: 'pine-hill', vid: 'Qm9vdHN0cmFwcGVkVmFsdWU5' })
    expect(opaque?.cookies.map(cookie => `${cookie.name}:${cookie.source}`)).toEqual(['store:script', 'vid:browser'])
    expect(opaque?.requires).toBe('browser')
    const bot = sessionOf({ _px3: 'abc' })
    expect(bot?.cookies).toEqual([
      { name: '_px3', setBy: null, source: 'browser' },
    ])
    expect(bot?.requires).toBe('browser')
  })
})

describe('buildFlows: cookies nothing in the capture produced', () => {
  /** Two sessions from one reused browser profile: `sid` is the same login cookie in both. */
  function twoSessions(hosts: readonly string[], cookieFor: (host: string, sessionId: string) => Record<string, string>): FlowsDocument['session'] {
    const exchanges: Exchange[] = []
    const operations: Operation[] = []
    for (const host of hosts) {
      const calls = ['s1', 's2'].map((sessionId, index) => exchange({
        sessionId,
        url: `https://${host}/api/account`,
        startedAt: 1_000 * (index + 1),
        cookies: cookieFor(host, sessionId),
        responseBody: jsonBody({ ok: true }),
      }))
      exchanges.push(...calls)
      operations.push(op(`getAccount_${host}`, calls, {
        cookies: Object.keys(cookieFor(host, 's1')).map(name => ({ name, required: true, schema: {} })),
      }))
    }
    const sessions = [
      loaded('s1', []),
      loaded('s2', []),
    ]
    const traces = traceValues({
      exchanges,
      sessions,
      htmlLocator: fakeHtmlLocator,
      staticStrings: new Set(),
      minValueLength: 4,
    })
    return build(exchanges, operations, sessions, traces).session
  }

  it('reports a shared cookie no response or script produced as unknown, not script, and needs no browser for it', () => {
    const session = twoSessions(['profile.example.test'], () => ({ sid: 'Lg7Hq2Vx9Kd4Pw1Z' }))
    expect(session).toEqual([
      {
        host: 'profile.example.test',
        requires: 'cookies',
        cookies: [
          { name: 'sid', setBy: null, source: 'unknown' },
        ],
        botProtection: [],
        probed: false,
      },
    ])
  })

  it('keys cookie origins by host and name', () => {
    // `vid` is opaque and different per session on one host, and constant on the other.
    const session = twoSessions(['a.example.test', 'b.example.test'], (host, sessionId) => ({
      vid: host === 'a.example.test'
        ? `Qm9vdHN0cmFwcGVk${sessionId}VmFsdWU5`
        : 'Lg7Hq2Vx9Kd4Pw1Z',
    }))
    expect(session.map(entry => [
      entry.host,
      entry.requires,
      entry.cookies.map(cookie => `${cookie.name}:${cookie.source}`),
    ])).toEqual([
      [
        'a.example.test',
        'browser',
        ['vid:browser'],
      ],
      [
        'b.example.test',
        'cookies',
        ['vid:unknown'],
      ],
    ])
  })
})

describe('buildFlows: what counts as an input', () => {
  it('skips literal path segments and bot-protection payloads, keeps real path parameters', () => {
    const list = exchange({
      url: `https://${HOST}/api/items`,
      responseBody: jsonBody([
        { id: 'X81234567' },
      ]),
      startedAt: 1_000,
    })
    const file = exchange({ url: `https://${HOST}/api/stock.txt`, startedAt: 2_000 })
    const item = exchange({ url: `https://${HOST}/api/items/X81234567`, startedAt: 3_000 })
    const sensor = exchange({
      method: 'POST',
      url: `https://${HOST}/shield/collect`,
      requestBody: jsonBody({ sensor_data: '3;0;1;0;abcdefghij' }),
      kind: 'bot-protection',
      startedAt: 4_000,
    })
    const operations: Operation[] = [
      {
        ...operationStub('getApiItems', '/api/items'),
        exchanges: [list],
      },
      {
        ...operationStub('getApiStockTxt', '/api/stock.txt'),
        exchanges: [file],
      },
      {
        ...operationStub('getApiItemsByItemId', '/api/items/{itemId}'),
        pathParams: [
          {
            name: 'itemId',
            index: 2,
            schema: { type: 'string' },
            evidence: ['varies'],
          },
        ],
        exchanges: [item],
      },
      {
        ...operationStub('postShieldCollect', '/shield/collect'),
        method: 'POST',
        kind: 'bot-protection',
        exchanges: [sensor],
      },
    ]
    const exchanges = [list, file, item, sensor]
    const sessions: LoadedSession[] = [
      {
        dir: '/tmp/s1',
        events: [],
        meta: sessionMeta('s1'),
      },
    ]
    const traces = traceValues({
      exchanges,
      sessions,
      htmlLocator: fakeHtmlLocator,
      staticStrings: new Set(),
      minValueLength: 4,
    })
    const doc = buildFlows({
      exchanges,
      operations,
      sessions,
      traces,
      sourceResolver: fakeSourceResolver,
      botProtection: [],
      redactor: redactorFor(exchanges),
      toolVersion: 'test',
    })
    const steps = doc.flows.flatMap(entry => entry.steps)
    expect(steps.find(step => step.operationId === 'getApiStockTxt')?.inputs).toEqual({})
    expect(steps.find(step => step.operationId === 'postShieldCollect')?.inputs).toEqual({})
    expect(steps.find(step => step.operationId === 'getApiItemsByItemId')?.inputs['path.2']?.kind).toBe('step')
  })
})

describe('buildFlows: values taken from one of several items', () => {
  const page = 'https://shop.example.test/'

  it('writes array indexes of producing locations as `*`, but keeps numeric object keys', () => {
    const list = exchange({
      url: 'https://shop.example.test/api/categories',
      startedAt: 1,
      responseBody: jsonBody([
        { slug: 'pantry' },
        { slug: 'snacks' },
      ]),
    })
    const years = exchange({
      url: 'https://shop.example.test/api/years',
      startedAt: 2,
      responseBody: jsonBody({
        2024: { report: 'rep-2024-a' },
      }),
    })
    const products = exchange({ url: 'https://shop.example.test/api/products?category=snacks&report=rep-2024-a', startedAt: 3 })
    const exchanges = [list, years, products]
    const traces: ValueTrace[] = [
      {
        exchangeId: products.id,
        location: { in: 'query', name: 'category' },
        value: 'snacks',
        origin: {
          kind: 'response',
          exchangeId: list.id,
          location: { in: 'body', pointer: '/1/slug' },
          transform: 'none',
        },
      },
      {
        exchangeId: products.id,
        location: { in: 'query', name: 'report' },
        value: 'rep-2024-a',
        origin: {
          kind: 'response',
          exchangeId: years.id,
          location: { in: 'body', pointer: '/2024/report' },
          transform: 'none',
        },
      },
    ]
    const doc = build(exchanges, [
      op('getApiCategories', [list]),
      op('getApiYears', [years]),
      op('getApiProducts', [products]),
    ], [
      loaded('s1', [], page),
    ], traces)
    const steps = doc.flows.flatMap(entry => entry.steps)
    const consumer = steps.find(step => step.operationId === 'getApiProducts')
    expect(consumer?.inputs['query.category']).toMatchObject({ kind: 'step', output: 'body./*/slug' })
    expect(consumer?.inputs['query.report']).toMatchObject({ kind: 'step', output: 'body./2024/report' })
    expect(steps.find(step => step.operationId === 'getApiCategories')?.outputs).toEqual({ slug: 'body./*/slug' })
  })

  it('writes {key} for pointer segments and form names that are secret or personal values (decision 0042)', () => {
    const userId = '3f2c9a4e-1b7d-4c8e-9f60-2a5b8c1d7e43'
    const token = 'Zq8xT2mLp4VwRk7YbN3c'
    const me = exchange({
      url: 'https://shop.example.test/api/me',
      startedAt: 1,
      responseBody: jsonBody({ userId }),
    })
    const carts = exchange({
      url: 'https://shop.example.test/api/carts',
      startedAt: 2,
      responseBody: jsonBody({
        carts: {
          [userId]: { cartRef: 'cart-77aa-ref' },
        },
      }),
    })
    const checkout = exchange({
      method: 'POST',
      url: 'https://shop.example.test/api/checkout',
      startedAt: 3,
      requestBody: jsonBody({
        owners: { [userId]: 'cart-77aa-ref' },
      }),
    })
    const vote = exchange({
      method: 'POST',
      url: 'https://shop.example.test/api/vote',
      startedAt: 4,
      requestBody: formBody({ [token]: 'cart-77aa-ref' }),
    })
    const exchanges = [me, carts, checkout, vote]
    const fromCarts = {
      kind: 'response',
      exchangeId: carts.id,
      location: { in: 'body', pointer: `/carts/${userId}/cartRef` },
      transform: 'none',
    } as const
    const traces: ValueTrace[] = [
      {
        exchangeId: checkout.id,
        location: { in: 'body', pointer: `/owners/${userId}` },
        value: 'cart-77aa-ref',
        origin: fromCarts,
      },
      {
        exchangeId: vote.id,
        location: { in: 'form', name: token },
        value: 'cart-77aa-ref',
        origin: fromCarts,
      },
    ]
    const doc = build(exchanges, [
      op('getApiMe', [me]),
      op('getApiCarts', [carts]),
      op('postApiCheckout', [checkout]),
      op('postApiVote', [vote]),
    ], [
      loaded('s1', [], 'https://shop.example.test/'),
    ], traces)
    const steps = doc.flows.flatMap(entry => entry.steps)
    expect(steps.find(step => step.operationId === 'postApiCheckout')?.inputs['body./owners/{key}'])
      .toMatchObject({ kind: 'step', output: 'body./carts/{key}/cartRef' })
    expect(steps.find(step => step.operationId === 'postApiVote')?.inputs['form.{key}'])
      .toMatchObject({ kind: 'step', output: 'body./carts/{key}/cartRef' })
    expect(steps.find(step => step.operationId === 'getApiCarts')?.outputs).toEqual({ cartRef: 'body./carts/{key}/cartRef' })
    const text = JSON.stringify(doc)
    expect(text).not.toContain(userId)
    expect(text).not.toContain(token)
  })

  it('unescapes pointer segments before judging them, so a secret key with / or ~ becomes {key}', () => {
    // A cookie value is always secret; as a key it is escaped in the pointer (`~1`, `~0`), a form
    // the text scan alone would not recognise.
    const sid = 'ab/cd~ef12345'
    const pointer = '/owners/ab~1cd~0ef12345'
    const list = exchange({
      url: 'https://shop.example.test/api/owners',
      startedAt: 1,
      cookies: { sid },
      responseBody: jsonBody({
        owners: { [sid]: 'own-ref-123' },
      }),
    })
    const save = exchange({
      method: 'POST',
      url: 'https://shop.example.test/api/save',
      startedAt: 2,
      requestBody: jsonBody({
        owners: { [sid]: 'own-ref-123' },
      }),
    })
    const traces: ValueTrace[] = [
      {
        exchangeId: save.id,
        location: { in: 'body', pointer },
        value: 'own-ref-123',
        origin: {
          kind: 'response',
          exchangeId: list.id,
          location: { in: 'body', pointer },
          transform: 'none',
        },
      },
    ]
    const doc = build([list, save], [
      op('getApiOwners', [list]),
      op('postApiSave', [save]),
    ], [
      loaded('s1', [], 'https://shop.example.test/'),
    ], traces)
    const input = doc.flows.flatMap(entry => entry.steps).find(step => step.operationId === 'postApiSave')?.inputs
    expect(Object.keys(input ?? {})).toEqual(['body./owners/{key}'])
    expect(input?.['body./owners/{key}']).toMatchObject({ kind: 'step', output: 'body./owners/{key}' })
    const text = JSON.stringify(doc)
    expect(text).not.toContain('ab~1cd~0ef12345')
    expect(text).not.toContain(sid)
  })

  it('generalises HTML selectors that differ only by position across samples to the repeated element', () => {
    const html = '<ul id="store-list"><li><a href="/stores/pine-hill">Pine</a></li><li><a href="/stores/cedar-park">Cedar</a></li></ul>'
    const stores = ['s1', 's2'].map(sessionId => exchange({
      url: 'https://shop.example.test/stores',
      sessionId,
      startedAt: 1,
      responseBody: {
        mimeType: 'text/html',
        text: html,
        base64: null,
        json: undefined,
        form: null,
      },
    }))
    const stock = [
      exchange({
        url: 'https://shop.example.test/api/stock',
        sessionId: 's1',
        startedAt: 2,
        cookies: { pm_store: 'pine-hill' },
      }),
      exchange({
        url: 'https://shop.example.test/api/stock',
        sessionId: 's2',
        startedAt: 2,
        cookies: { pm_store: 'cedar-park' },
      }),
    ]
    const at = (position: number): ValueTrace['origin'] => ({
      kind: 'response',
      exchangeId: stores[position - 1]!.id,
      location: {
        in: 'html',
        selector: `#store-list > li:nth-of-type(${position}) > a:nth-of-type(1)`,
        attr: 'href',
        pattern: '/stores/([\\w-]+)',
      },
      transform: 'none',
    })
    const traces: ValueTrace[] = [
      {
        exchangeId: stock[0]!.id,
        location: { in: 'cookie', name: 'pm_store' },
        value: 'pine-hill',
        origin: at(1),
      },
      {
        exchangeId: stock[1]!.id,
        location: { in: 'cookie', name: 'pm_store' },
        value: 'cedar-park',
        origin: at(2),
      },
    ]
    const doc = build([
      ...stores,
      ...stock,
    ], [
      op('getStores', stores),
      op('getApiStock', stock),
    ], [
      loaded('s1', [], page),
      loaded('s2', [], page),
    ], traces)
    const steps = doc.flows.flatMap(entry => entry.steps)
    expect(steps.find(step => step.operationId === 'getApiStock')?.inputs['cookie.pm_store']).toEqual({
      kind: 'html',
      step: 's1',
      selector: '#store-list > li > a:nth-of-type(1)',
      attr: 'href',
      pattern: '/stores/([\\w-]+)',
      confidence: 'high',
      repeated: true,
    })
    expect(steps.find(step => step.operationId === 'getStores')?.outputs).toEqual({
      'store-list': 'html.#store-list > li > a:nth-of-type(1)@href //stores/([\\w-]+)/',
    })
  })

  it('keeps a positional selector seen at one position only', () => {
    const html = '<ul id="store-list"><li><a href="/stores/pine-hill">Pine</a></li></ul>'
    const stores = exchange({
      url: 'https://shop.example.test/stores',
      startedAt: 1,
      responseBody: {
        mimeType: 'text/html',
        text: html,
        base64: null,
        json: undefined,
        form: null,
      },
    })
    const stock = exchange({
      url: 'https://shop.example.test/api/stock',
      startedAt: 2,
      cookies: { pm_store: 'pine-hill' },
    })
    const location = {
      in: 'html' as const,
      selector: '#store-list > li:nth-of-type(1) > a:nth-of-type(1)',
      attr: 'href',
      pattern: null,
    }
    const doc = build([stores, stock], [
      op('getStores', [stores]),
      op('getApiStock', [stock]),
    ], [
      loaded('s1', [], page),
    ], [
      {
        exchangeId: stock.id,
        location: { in: 'cookie', name: 'pm_store' },
        value: 'pine-hill',
        origin: {
          kind: 'response',
          exchangeId: stores.id,
          location,
          transform: 'none',
        },
      },
    ])
    const input = doc.flows.flatMap(entry => entry.steps).find(step => step.operationId === 'getApiStock')?.inputs['cookie.pm_store']
    expect(input).toMatchObject({ kind: 'html', selector: location.selector })
    expect(input).not.toHaveProperty('repeated')
  })
})

describe('buildFlows: computed values that use typed input', () => {
  const page = 'https://shop.example.test/login'

  function computed(inputs: string[], changedOn = page, responseBody = jsonBody({ publicKey: 'PUBLICKEY-0123456789' })): FlowsDocument['computedValues'][number] | undefined {
    const key = exchange({ url: 'https://shop.example.test/api/key', startedAt: 1, responseBody })
    const login = exchange({
      method: 'POST',
      url: 'https://shop.example.test/api/login',
      startedAt: 10,
      requestBody: jsonBody({ username: 'demo', password: 'ENCRYPTED-OUTPUT' }),
    })
    const events: CaptureEvent[] = [
      {
        t: 'action',
        ts: 2,
        pageUrl: changedOn,
        kind: 'change',
        label: 'Username',
        selector: '#username',
        field: 'username',
      },
      {
        t: 'action',
        ts: 3,
        pageUrl: changedOn,
        kind: 'change',
        label: 'Password',
        selector: '#password',
        field: 'password',
      },
      {
        t: 'transform',
        ts: 9,
        pageUrl: page,
        api: 'crypto.subtle.encrypt',
        output: ['ENCRYPTED-OUTPUT'],
        inputs,
        details: null,
        stack: [],
      },
    ]
    const sessions = [
      loaded('s1', events, page),
    ]
    const traces: ValueTrace[] = [
      {
        exchangeId: login.id,
        location: { in: 'body', pointer: '/username' },
        value: 'demo',
        origin: { kind: 'user-input', field: 'username' },
      },
      {
        exchangeId: login.id,
        location: { in: 'body', pointer: '/password' },
        value: 'ENCRYPTED-OUTPUT',
        origin: { kind: 'transform', eventIndex: events.length - 1, sessionId: 's1' },
      },
    ]
    return build([key, login], [
      op('getApiKey', [key]),
      op('postApiLogin', [login]),
    ], sessions, traces).computedValues[0]
  }

  it('adds the password field the person typed, next to the key from a response', () => {
    expect(computed(['PUBLICKEY-0123456789', 'hunter2-password'])?.uses).toEqual([
      {
        kind: 'step',
        step: 'load-login.s1',
        output: 'body./publicKey',
        transform: 'none',
      },
      { kind: 'user-input', field: 'password' },
    ])
  })

  it('names the field whose value the request also sends as-is', () => {
    expect(computed(['demo'])?.uses).toEqual([
      { kind: 'user-input', field: 'username' },
    ])
  })

  it('ignores bytes, previews found in a response, and fields changed on another page', () => {
    expect(computed(['\u0001\u0002binary-bytes'])?.uses).toEqual([])
    // Found in a response: a use of that response, not typing.
    expect(computed(['in-response-1'], page, jsonBody({ publicKey: 'x', note: 'in-response-1' }))?.uses).toEqual([
      {
        kind: 'step',
        step: 'load-login.s1',
        output: 'body./note',
        transform: 'none',
      },
    ])
    // A cut-off preview is data, not something typed.
    expect(computed([
      'x'.repeat(256),
    ])?.uses).toEqual([])
    expect(computed(['typed-secret'], 'https://shop.example.test/register')?.uses).toEqual([])
    expect(computed(['typed-secret'])?.uses).toEqual([
      { kind: 'user-input', field: 'password' },
    ])
  })
})

function operationStub(operationId: string, path: string): Operation {
  return {
    operationId,
    host: HOST,
    method: 'GET',
    path,
    kind: 'api',
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses: [],
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges: [],
  }
}

function sessionMeta(sessionId: string): LoadedSession['meta'] {
  return {
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
  }
}

describe('buildFlows: time-based one-time codes', () => {
  const tokenRequest = (sessionId: string, totp: string): Exchange => exchange({
    sessionId,
    url: `https://open.music.test/api/token?reason=init&totp=${totp}&totpServer=${totp}`,
    startedAt: 1,
    responseBody: jsonBody({ isAnonymous: true }),
  })
  const flowsFor = (oneTimeCodes: BuildFlowsInput['oneTimeCodes']): FlowsDocument => {
    const stores = (sessionId: string, pincode: string): Exchange => exchange({ sessionId, url: `https://open.music.test/api/stores?pincode=${pincode}`, startedAt: 2 })
    const exchanges = [
      tokenRequest('a', '180073'),
      stores('a', '560001'),
      tokenRequest('b', '594010'),
      stores('b', '411014'),
    ]
    const sessions: LoadedSession[] = [
      {
        dir: '/tmp/a',
        events: [],
        meta: sessionMeta('a'),
      },
      {
        dir: '/tmp/b',
        events: [],
        meta: sessionMeta('b'),
      },
    ]
    const operations = [
      op('getApiToken', exchanges.filter(entry => entry.request.path === '/api/token')),
      op('getApiStores', exchanges.filter(entry => entry.request.path === '/api/stores')),
    ]
    const traces = traceValues({
      exchanges,
      sessions,
      htmlLocator: fakeHtmlLocator,
      staticStrings: new Set(),
      minValueLength: 4,
    })
    return buildFlows({
      exchanges,
      operations,
      sessions,
      traces,
      sourceResolver: fakeSourceResolver,
      botProtection: [],
      redactor: redactorFor(exchanges),
      toolVersion: 'test',
      oneTimeCodes,
    })
  }

  it('records an untraced code under a field the site\'s code fills with a TOTP as a computed value', () => {
    const ref = {
      file: '/cdn/web-player.js',
      line: 30,
      column: 120,
      functionName: 'eV',
      original: false,
      excerpt: null,
    }
    const doc = flowsFor(new Map([
      [
        'totp',
        {
          field: 'totp',
          ref,
          config: { digits: 6, period: 30, algorithm: 'SHA1' },
        },
      ],
    ]))
    const inputs = doc.flows[0]?.steps[0]?.inputs ?? {}
    expect(inputs['query.totp']).toEqual({ kind: 'computed', computedId: 'getapitoken-query-totp' })
    expect(doc.computedValues).toEqual([
      expect.objectContaining({
        operationId: 'getApiToken',
        input: 'query.totp',
        producedBy: ref,
        api: 'TOTP (time-based one-time code)',
        details: { digits: '6', period: '30s', algorithm: 'SHA1' },
        evidence: 'source-trace',
      }),
    ])
    // Without code evidence, a code sent to a token endpoint is still called what it most likely is.
    expect(inputs['query.totpServer']).toEqual({ kind: 'unknown', shape: '6-digit number; likely a time-based code computed in the browser' })
  })

  it('says a code is likely time-based when the code is not found, but not for a postcode', () => {
    const steps = flowsFor(new Map()).flows[0]?.steps ?? []
    expect(steps[0]?.inputs['query.totp']).toEqual({ kind: 'unknown', shape: '6-digit number; likely a time-based code computed in the browser' })
    expect(steps[1]?.inputs['query.pincode']).toEqual({ kind: 'unknown', shape: '6-digit number' })
  })
})
