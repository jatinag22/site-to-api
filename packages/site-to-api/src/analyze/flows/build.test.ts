import type { ResolvedConfig } from '../../config/schema'
import type { CaptureEvent, Exchange, FlowsDocument, LoadedSession, Operation, Redactor, ValueTrace } from '../../model'
import type { BuildFlowsInput } from './index'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody } from '../../../test/helpers'
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
      output: 'body./items/0/id',
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
    expect(items?.outputs).toEqual({ id: 'body./items/0/id' })
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
        uses: [
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
        ['sid:browser'],
      ],
      ['plain.example.test', 'none', []],
      ['token.example.test', 'token', []],
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
