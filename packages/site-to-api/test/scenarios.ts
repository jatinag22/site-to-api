/**
 * A hand-built two-session capture of a small shop: load the login page, sign in, open an item.
 * Shared by the correlate, flows and emit tests. Every secret below is invented for the tests;
 * {@link SECRET_VALUES} lists them so tests can check none reaches the output.
 */
import type {
  BotProtectionFinding,
  CaptureEvent,
  Exchange,
  HtmlLocator,
  LoadedSession,
  Operation,
  SourceRef,
  SourceResolver,
  StackFrame,
} from '../src/model'
import { exchange, jsonBody, textBody } from './helpers'

export const HOST = 'shop.example.test'
const ORIGIN = `https://${HOST}`

function fakeJwt(subject: string): string {
  const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: subject, exp: 1900000000 })}.c2lnbmF0dXJlLWZvci10ZXN0cw`
}

interface SessionSecrets {
  csrf: string
  sessionCookie: string
  botCookie: string
  token: string
  password: string
  encryptedPassword: string
  username: string
}

const SECRETS: Record<'a' | 'b', SessionSecrets> = {
  a: {
    csrf: 'csrf-9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    sessionCookie: 'sess-a1b2c3d4e5f60718293a4b5c6d7e8f90',
    botCookie: 'abck~0~YAAQ1234567890abcdefghij~-1~',
    token: fakeJwt('user-a-0001'),
    password: 'hunter2-plain-password-a',
    encryptedPassword: 'RW5jcnlwdGVkUGFzc3dvcmRCbG9iQUFBQUFBQUFB',
    username: 'alice.person@example.test',
  },
  b: {
    csrf: 'csrf-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    sessionCookie: 'sess-ffeeddccbbaa99887766554433221100',
    botCookie: 'abck~0~YAAQ0987654321zyxwvutsrqpo~-1~',
    token: fakeJwt('user-b-0002'),
    password: 'hunter2-plain-password-b',
    encryptedPassword: 'RW5jcnlwdGVkUGFzc3dvcmRCbG9iQkJCQkJCQkJC',
    username: 'bob.person@example.test',
  },
}

/** A constant that looks like a credential: it must be written as a shape, not a value. */
export const CONSTANT_API_KEY = 'pk_constant_0001_abcdef'
/** A constant that does not look like a credential: it is kept as-is. */
export const CLIENT_VERSION = 'web-4.2.1'
export const ITEM_ID = 'ITM-7731-XQ'
const PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestpublickey'

/** Every value that must never appear in `flows.json` or `flows.md`. */
export const SECRET_VALUES: readonly string[] = [
  ...Object.values(SECRETS).flatMap(secrets => Object.values(secrets)),
  CONSTANT_API_KEY,
]

function frame(functionName: string, line: number): StackFrame {
  return {
    url: `${ORIGIN}/assets/app.js`,
    line,
    column: 7,
    functionName,
  }
}

function withInitiator(target: Exchange, functionName: string, line: number): Exchange {
  target.initiator = {
    via: 'fetch',
    stack: [
      frame(functionName, line),
    ],
  }
  return target
}

export interface ShopSession {
  session: LoadedSession
  exchanges: Exchange[]
  /** Named exchanges for assertions. */
  named: Record<'loginPage' | 'sensor' | 'config' | 'login' | 'items' | 'pollA' | 'pollB' | 'item', Exchange>
}

function shopSession(sessionId: 'a' | 'b', start: number): ShopSession {
  const secrets = SECRETS[sessionId]
  const at = (offset: number): number => start + offset
  const commonHeaders = { 'x-client-version': CLIENT_VERSION, 'x-api-key': CONSTANT_API_KEY }
  const auth = { authorization: `Bearer ${secrets.token}` }
  const cookies = { session: secrets.sessionCookie, _abck: secrets.botCookie }

  const loginPage = exchange({
    url: `${ORIGIN}/login?next=%2Faccount`,
    sessionId,
    startedAt: at(0),
    resourceType: 'document',
    kind: 'page',
    responseBody: textBody(`<html><head><meta name="csrf-token" content="${secrets.csrf}"></head><body><form id="login"></form></body></html>`),
    setCookies: { session: secrets.sessionCookie },
  })
  const sensor = exchange({
    method: 'POST',
    url: `${ORIGIN}/akam/13/pixel_1a2b`,
    sessionId,
    startedAt: at(100),
    kind: 'bot-protection',
    responseBody: jsonBody({ success: true }),
  })
  const config = withInitiator(exchange({
    url: `${ORIGIN}/api/config`,
    sessionId,
    startedAt: at(200),
    requestHeaders: commonHeaders,
    responseBody: jsonBody({
      publicKey: PUBLIC_KEY,
      features: ['search'],
    }),
  }), 'loadConfig', 10)
  const login = withInitiator(exchange({
    method: 'POST',
    url: `${ORIGIN}/api/login`,
    sessionId,
    startedAt: at(5000),
    requestHeaders: { ...commonHeaders, 'x-csrf-token': secrets.csrf, 'content-type': 'application/json' },
    cookies,
    requestBody: jsonBody({ username: secrets.username, password: secrets.encryptedPassword, remember: true }),
    responseBody: jsonBody({
      token: secrets.token,
      user: { displayName: 'Shopper' },
    }),
  }), 'submitLogin', 42)
  const items = withInitiator(exchange({
    url: `${ORIGIN}/api/items?limit=20`,
    sessionId,
    startedAt: at(5300),
    requestHeaders: {
      ...commonHeaders,
      ...auth,
    },
    cookies,
    responseBody: jsonBody({
      items: [
        { id: ITEM_ID, name: 'Blue mug' },
      ],
      total: 1,
    }),
  }), 'listItems', 77)
  const pollA = exchange({
    url: `${ORIGIN}/api/notifications?_=${at(5400)}`,
    sessionId,
    startedAt: at(5400),
    requestHeaders: auth,
    responseBody: jsonBody({ unread: 0 }),
  })
  const pollB = exchange({
    url: `${ORIGIN}/api/notifications?_=${at(5900)}`,
    sessionId,
    startedAt: at(5900),
    requestHeaders: auth,
    responseBody: jsonBody({ unread: 0 }),
  })
  const item = withInitiator(exchange({
    url: `${ORIGIN}/api/items/${ITEM_ID}`,
    sessionId,
    startedAt: at(9000),
    requestHeaders: {
      ...commonHeaders,
      ...auth,
    },
    cookies,
    responseBody: jsonBody({ id: ITEM_ID, name: 'Blue mug', price: 1250 }),
  }), 'openItem', 120)

  const pageUrl = `${ORIGIN}/login?next=%2Faccount`
  const events: CaptureEvent[] = [
    {
      t: 'action',
      ts: at(1000),
      pageUrl,
      kind: 'change',
      label: 'Email',
      selector: '#username',
      field: 'username',
    },
    {
      t: 'action',
      ts: at(1500),
      pageUrl,
      kind: 'change',
      label: 'Password',
      selector: '#password',
      field: 'password',
    },
    {
      t: 'transform',
      ts: at(4900),
      pageUrl,
      api: 'JSEncrypt.encrypt',
      output: [secrets.encryptedPassword],
      inputs: [
        secrets.password,
        PUBLIC_KEY.slice(0, 40),
      ],
      details: { padding: 'pkcs1' },
      stack: [
        frame('encryptPassword', 300),
      ],
    },
    {
      t: 'action',
      ts: at(4950),
      pageUrl,
      kind: 'submit',
      label: 'Sign in',
      selector: 'form#login',
      field: null,
    },
    // The navigation the submit caused: part of the same flow.
    {
      t: 'action',
      ts: at(5600),
      pageUrl: `${ORIGIN}/account`,
      kind: 'navigate',
      label: 'My account',
      selector: '',
      field: null,
    },
    {
      t: 'action',
      ts: at(8900),
      pageUrl: `${ORIGIN}/account?tab=items`,
      kind: 'click',
      label: 'Blue mug',
      selector: 'a.item',
      field: null,
    },
  ]
  const session: LoadedSession = {
    dir: `/captures/${sessionId}`,
    events,
    meta: {
      formatVersion: 1,
      sessionId,
      toolVersion: '0.0.0-test',
      startUrl: pageUrl,
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(at(10000)).toISOString(),
      browser: { channel: null, headless: true, userAgent: 'test' },
      har: 'traffic.har',
      events: 'events.jsonl',
      scripts: [],
    },
  }
  return {
    session,
    exchanges: [
      loginPage,
      sensor,
      config,
      login,
      items,
      pollA,
      pollB,
      item,
    ],
    named: {
      loginPage,
      sensor,
      config,
      login,
      items,
      pollA,
      pollB,
      item,
    },
  }
}

function operation(operationId: string, kind: Operation['kind'], method: string, path: string, exchanges: Exchange[]): Operation {
  const first = exchanges[0]
  return {
    operationId,
    host: HOST,
    method,
    path,
    kind,
    pathParams: [],
    query: [],
    headers: [
      ...new Set(exchanges.flatMap(entry => entry.request.headers.map(header => header.name))),
    ].sort().map(name => ({
      name,
      required: true,
      schema: { type: 'string' },
      constant: false,
    })),
    cookies: [
      ...new Set(exchanges.flatMap(entry => entry.request.cookies.map(cookie => cookie.name))),
    ].sort().map(name => ({
      name,
      required: true,
      schema: { type: 'string' },
    })),
    requestBody: null,
    responses: [],
    sentFrom: [],
    sourceOnly: false,
    summary: first
      ? `${method} ${path}`
      : '',
    exchanges,
  }
}

export interface ShopCapture {
  sessions: ShopSession[]
  exchanges: Exchange[]
  operations: Operation[]
  botProtection: BotProtectionFinding[]
}

/** The full two-session capture with its operations. */
export function shopCapture(): ShopCapture {
  const sessions = [
    shopSession('a', 1_700_000_000_000),
    shopSession('b', 1_700_000_100_000),
  ]
  const all = (name: keyof ShopSession['named']): Exchange[] => sessions.map(entry => entry.named[name])
  const operations = [
    operation('getLogin', 'page', 'GET', '/login', all('loginPage')),
    operation('postAkamPixel', 'bot-protection', 'POST', '/akam/13/{pixel}', all('sensor')),
    operation('getApiConfig', 'api', 'GET', '/api/config', all('config')),
    operation('postApiLogin', 'api', 'POST', '/api/login', all('login')),
    operation('getApiItems', 'api', 'GET', '/api/items', all('items')),
    operation('getApiNotifications', 'api', 'GET', '/api/notifications', [
      ...all('pollA'),
      ...all('pollB'),
    ]),
    operation('getApiItemsId', 'api', 'GET', '/api/items/{id}', all('item')),
  ]
  operations[3]!.summary = 'Sign in with email and password'
  return {
    sessions,
    exchanges: sessions.flatMap(entry => entry.exchanges),
    operations,
    botProtection: [
      {
        vendor: 'Akamai',
        host: HOST,
        evidence: '/akam/ sensor endpoint and _abck cookie',
        exchangeIds: all('sensor').map(entry => entry.id),
      },
    ],
  }
}

/** Finds `<meta name="x" content="value">`, the way `analyze/html` would. */
export const fakeHtmlLocator: HtmlLocator = (document, value) => {
  const name = new RegExp(`<meta name="([^"]+)" content="${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(document)?.[1]
  return name === undefined
    ? null
    : { selector: `meta[name="${name}"]`, attr: 'content', pattern: null }
}

/** Resolves the first frame to an original file named after its function. */
export const fakeSourceResolver: SourceResolver = {
  resolve: (frame): SourceRef => ({
    file: `src/${frame.functionName ?? 'anonymous'}.ts`,
    line: frame.line,
    column: frame.column,
    functionName: frame.functionName,
    original: true,
    excerpt: null,
  }),
  callSite: (stack, sessionId) => {
    const top = stack[0]
    return top
      ? fakeSourceResolver.resolve(top, sessionId)
      : null
  },
}
