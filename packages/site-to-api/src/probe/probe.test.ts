import type { AddressInfo } from 'node:net'
import type { Operation } from '../model'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exchange, jsonBody, textBody } from '../../test/helpers'
import { applyGraphqlTypes } from '../analyze/graphql'
import { probeOperations, resemblesCapture } from './probe'
import { summarizeProbe } from './summary'

let origin: string
let requests = 0
const userAgents: string[] = []
const clientHints: string[] = []
function challenge(res: import('node:http').ServerResponse): void {
  res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge', 'server': 'cloudflare' }).end('<title>Just a moment...</title>')
}
type Handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void

function json(status: number, body: string): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(body)
  }
}

const ROUTES: Record<string, Handler> = {
  '/api/tags': (req, res) => {
    // As Cloudflare did on Stack Overflow: the `HeadlessChrome` token alone gets a challenge.
    userAgents.push(req.headers['user-agent'] ?? '')
    clientHints.push(String(req.headers['sec-ch-ua'] ?? ''))
    if ((req.headers['user-agent'] ?? '').includes('HeadlessChrome'))
      challenge(res)
    else
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}')
  },
  '/api/walled': (_req, res) => challenge(res),
  '/api/teapot': json(419, '{"error":"page expired"}'),
  '/api/login-only': json(401, '{"error":"login"}'),
  // Cloudflare's WAF rule against non-browser clients: a 403 with no sign of a login.
  '/api/firewalled': (_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain', 'server': 'cloudflare' }).end('error code: 1020')
  },
  '/api/redirected': (_req, res) => {
    res.writeHead(302, { location: '/login?next=/api/redirected' }).end()
  },
  '/api/login-form': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<form action="/session"><input name="user"><input type="password" name="pw"></form>')
  },
  '/api/open': json(200, '{"items":[1]}'),
  '/api/px': json(403, JSON.stringify({
    appId: 'PXabc123',
    jsClientSrc: '/abc/init.js',
    blockScript: '/abc/captcha/captcha.js?a=c',
    uuid: 'u',
    vid: 'v',
  })),
  '/api/denied-list': json(403, '{"items":[]}'),
  '/api/private': (req, res) => {
    const ok = (req.headers.cookie ?? '').includes('sid=good') && req.headers['x-api-key'] === 'k1'
    res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }).end(ok ? '{"items":[1],"total":1}' : '{"error":"forbidden"}')
  },
  '/humanity': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Shop - Prove your humanity</title></head><body>'.padEnd(1200, 'x'))
  },
  '/api/challenge': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>checking your browser</html>')
  },
}

const REDIRECTS: Record<string, string> = {
  '/r/devise': '/users/sign_in',
  '/r/wordpress': '/wp-login.php?redirect_to=%2Fapi',
  '/r/rails': '/sessions/new',
  '/r/oauth': 'https://id.example.com/oauth2/authorize?client_id=1',
  '/r/home': '/',
  '/r/products': '/products',
}

for (const [from, to] of Object.entries(REDIRECTS)) {
  ROUTES[from] = (_req, res) => {
    res.writeHead(302, { location: to }).end()
  }
}

const server = createServer((req, res) => {
  requests++
  const url = req.url ?? ''
  const route = ROUTES[url] ?? (url.startsWith('/graphql')
    ? json(200, '{"data":{"a":1}}')
    : null)
  if (route)
    route(req, res)
  else
    res.writeHead(404).end()
})

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

function op(operationId: string, method: string, path: string, init: Parameters<typeof exchange>[0]): Operation {
  return {
    operationId,
    host: new URL(origin).host,
    method,
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
    exchanges: [
      exchange(init),
    ],
  }
}

const config = {
  maxRps: 10,
  unsafeMethods: false,
  timeoutMs: 5000,
  minimizePerHost: 5,
}

describe('probeOperations', () => {
  it('finds which cookies and headers a request needs, without counting generic headers', async () => {
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        op('getPrivate', 'GET', '/api/private', {
          url: `${origin}/api/private`,
          cookies: { sid: 'good', theme: 'dark' },
          requestHeaders: {
            'x-api-key': 'k1',
            'referer': `${origin}/`,
            'accept': 'application/json',
            'user-agent': 'test',
          },
          responseBody: jsonBody({
            items: [1],
            total: 1,
          }),
        }),
        op('getOpen', 'GET', '/api/open', {
          url: `${origin}/api/open`,
          responseBody: jsonBody({
            items: [1],
          }),
        }),
      ],
    })
    const priv = report.operations.find(result => result.operationId === 'getPrivate')
    expect(priv).toMatchObject({
      replay: 'ok',
      bare: 'rejected',
      requires: ['cookie:sid', 'header:x-api-key'],
    })
    const open = report.operations.find(result => result.operationId === 'getOpen')
    expect(open).toMatchObject({ replay: 'ok', bare: 'ok', requires: [] })
  })

  it('treats a 200 challenge page as rejected when the capture had JSON', async () => {
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        op('getChallenge', 'GET', '/api/challenge', {
          url: `${origin}/api/challenge`,
          responseBody: jsonBody({ items: [] }),
        }),
      ],
    })
    expect(report.operations[0]).toMatchObject({ replay: 'rejected', requires: null, rejection: 'other' })
    // Both answers were 200: what differed is the body, not the session.
    expect(report.operations[0]?.note).toContain('text/html where the capture had application/json')
    expect(report.operations[0]?.note).not.toContain('not accepted')
  })

  it('names itself instead of replaying the capture browser\'s user agent and client hints', async () => {
    const report = await probeOperations({
      toolVersion: '1.2.3',
      config,
      operations: [
        op('getTags', 'GET', '/api/tags', {
          url: `${origin}/api/tags`,
          requestHeaders: {
            'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Chromium";v="156", "HeadlessChrome";v="156"',
          },
          responseBody: jsonBody({ items: [] }),
        }),
      ],
    })
    expect(report.operations[0]).toMatchObject({ replay: 'ok', bare: 'ok', requires: [] })
    expect(userAgents.length).toBeGreaterThan(0)
    expect(userAgents.every(agent => agent === 'site-to-api/1.2.3 (probe; automated)')).toBe(true)
    expect(clientHints.every(hint => hint === '')).toBe(true)
  })

  it('tells bot protection, a refused session (only on login evidence) and other refusals apart', async () => {
    const sample = (path: string): Parameters<typeof op>[3] => ({
      url: `${origin}${path}`,
      cookies: { sid: 'old' },
      responseBody: jsonBody({ items: [] }),
    })
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        op('getWalled', 'GET', '/api/walled', sample('/api/walled')),
        op('getTeapot', 'GET', '/api/teapot', sample('/api/teapot')),
        op('getLoginOnly', 'GET', '/api/login-only', sample('/api/login-only')),
        op('getFirewalled', 'GET', '/api/firewalled', sample('/api/firewalled')),
        op('getRedirected', 'GET', '/api/redirected', sample('/api/redirected')),
        op('getLoginForm', 'GET', '/api/login-form', sample('/api/login-form')),
      ],
    })
    const byId = new Map(report.operations.map(entry => [entry.operationId, entry]))
    expect(byId.get('getWalled')).toMatchObject({
      replay: 'rejected',
      rejection: 'bot-protection',
      statuses: [403, 403],
    })
    expect(byId.get('getWalled')?.note).toContain('Blocked by bot protection (Cloudflare: header cf-mitigated, status 403)')
    expect(byId.get('getWalled')?.note).not.toContain('not accepted')
    // Laravel's 419 is an expired session or CSRF token.
    expect(byId.get('getTeapot')).toMatchObject({
      rejection: 'session',
      statuses: [419, 419],
    })
    expect(byId.get('getTeapot')?.note).toContain('status 419 (session or CSRF token expired)')
    expect(byId.get('getLoginOnly')).toMatchObject({
      rejection: 'session',
      statuses: [401, 401],
    })
    expect(byId.get('getLoginOnly')?.note).toContain('not accepted any more: the site answered with status 401 with a JSON error')
    expect(byId.get('getFirewalled')).toMatchObject({
      rejection: 'other',
      statuses: [403, 403],
    })
    expect(byId.get('getFirewalled')?.note).toContain('showed no sign of a login')
    expect(byId.get('getFirewalled')?.note).not.toContain('not an authentication failure')
    expect(byId.get('getRedirected')).toMatchObject({ rejection: 'session' })
    expect(byId.get('getRedirected')?.note).toContain('a redirect to /login')
    expect(byId.get('getLoginForm')).toMatchObject({ rejection: 'session' })
    expect(byId.get('getLoginForm')?.note).toContain('a login form where the capture had JSON')
  })

  it('reads login redirects of common frameworks as a refused session, and other redirects not', async () => {
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        ...Object.keys(REDIRECTS),
        '/api/px',
        '/api/denied-list',
      ].map(path => op(`get${path.replace(/\W/g, '')}`, 'GET', path, {
        url: `${origin}${path}`,
        cookies: { sid: 'old' },
        responseBody: jsonBody({ items: [] }),
      })),
    })
    const rejection = Object.fromEntries(report.operations.map(entry => [entry.operationId, entry.rejection]))
    expect(rejection).toEqual({
      getrdevise: 'session',
      getrwordpress: 'session',
      getrrails: 'session',
      getroauth: 'session',
      getrhome: 'other',
      getrproducts: 'other',
      getapipx: 'bot-protection',
      getapideniedlist: 'other',
    })
  })

  it('says the site answered with a challenge page, not that the session expired', async () => {
    const page = op('getHumanity', 'GET', '/humanity', {
      url: `${origin}/humanity`,
      resourceType: 'document',
      responseBody: textBody('<html><head><title>Shop</title></head><body>'.padEnd(1200, 'y')),
    })
    page.kind = 'page'
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [page],
    })
    expect(report.operations[0]).toMatchObject({ replay: 'rejected', requires: null })
    expect(report.operations[0]).toMatchObject({ rejection: 'bot-protection' })
    expect(report.operations[0]?.note).toContain('Blocked by bot protection (challenge page')
    expect(summarizeProbe(report).join('\n')).toContain('blocked by bot protection (not a session problem; these need a real browser): 1 (getHumanity)')
  })

  it('skips unsafe methods and bot-protection steps by default, without sending anything', async () => {
    const before = requests
    const botStep = op('postShield', 'POST', '/shield/collect', { method: 'POST', url: `${origin}/shield/collect` })
    botStep.kind = 'bot-protection'
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        op('postOrder', 'POST', '/api/order', { method: 'POST', url: `${origin}/api/order` }),
        botStep,
      ],
    })
    expect(requests).toBe(before)
    expect(report.skipped.map(entry => entry.operationId).sort()).toEqual(['postOrder', 'postShield'])
    expect(report.skipped.find(entry => entry.operationId === 'postOrder')?.reason).toContain('--unsafe-methods')
  })

  it('minimizes at most probe.minimizePerHost operations per host and records the limit', async () => {
    const report = await probeOperations({
      toolVersion: 'test',
      config: { ...config, minimizePerHost: 0 },
      operations: [
        op('getPrivate', 'GET', '/api/private', {
          url: `${origin}/api/private`,
          cookies: { sid: 'good' },
          requestHeaders: { 'x-api-key': 'k1' },
          responseBody: jsonBody({
            items: [1],
            total: 1,
          }),
        }),
      ],
    })
    expect(report.minimizePerHost).toBe(0)
    expect(report.operations[0]).toMatchObject({ replay: 'ok', bare: 'rejected', requires: null })
    expect(report.operations[0]?.note).toContain('--minimize-per-host')
  })

  it('skips endpoints seen only in code with a reason that says so', async () => {
    const related = op('getRelated', 'GET', '/api/related', { url: `${origin}/api/related` })
    related.sourceOnly = true
    related.exchanges = []
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [related],
    })
    expect(report.skipped).toEqual([
      { operationId: 'getRelated', reason: 'seen in code only: it was never called during capture, so there is no request to replay' },
    ])
  })

  it('spaces requests according to maxRps', async () => {
    let clock = 0
    const waits: number[] = []
    await probeOperations({
      toolVersion: 'test',
      config: { ...config, maxRps: 2 },
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms)
        clock += ms
      },
      operations: [
        op('getOpen', 'GET', '/api/open', {
          url: `${origin}/api/open`,
          responseBody: jsonBody({
            items: [1],
          }),
        }),
      ],
    })
    expect(waits).toEqual([500])
  })
})

describe('resemblesCapture', () => {
  const html = exchange({
    url: 'https://x.test/page',
    responseBody: textBody('<html>'.padEnd(1000, 'x')),
  })

  it('compares HTML by size so tiny error pages do not count as success', () => {
    expect(resemblesCapture(html, 200, 'text/html; charset=utf-8', '<html>'.padEnd(900, 'y'))).toBe(true)
    expect(resemblesCapture(html, 200, 'text/html', '<html>denied</html>')).toBe(false)
    expect(resemblesCapture(html, 302, 'text/html', '')).toBe(false)
  })

  it('never takes an AWS WAF challenge for success, by header or by its interstitial', () => {
    const goku = '<html><head><script>window.gokuProps = { "key": "k" }</script></head><body>'.padEnd(1000, 'z')
    expect(resemblesCapture(html, 202, 'text/html', goku, [
      { name: 'x-amzn-waf-action', value: 'challenge' },
    ])).toBe(false)
    expect(resemblesCapture(html, 200, 'text/html', '<html>'.padEnd(900, 'y'), [
      { name: 'X-Amzn-Waf-Action', value: 'challenge' },
    ])).toBe(false)
    expect(resemblesCapture(html, 200, 'text/html', goku)).toBe(false)
  })

  it('never takes a challenge page answered 200 for the page', () => {
    const challenge = '<html><head><title>Shop - Prove your humanity</title></head><body>'.padEnd(1000, 'z')
    expect(resemblesCapture(html, 200, 'text/html', challenge)).toBe(false)
  })
})

describe('probeOperations: challenge tokens', () => {
  it('never replays a request that carries a Cloudflare challenge token', async () => {
    const page = op('getQuestions', 'GET', '/questions', {
      url: 'https://x.test/questions?__cf_chl_tk=abc-1700000000-0-gaN',
      resourceType: 'document',
      responseBody: textBody('<html>'.padEnd(900, 'q')),
    })
    page.kind = 'page'
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [page],
    })
    expect(report.operations).toEqual([])
    expect(report.skipped).toEqual([
      { operationId: 'getQuestions', reason: 'no successful response was captured' },
    ])
  })
})

describe('probeOperations: challenge pages in the capture', () => {
  it('does not replay a page whose only successful samples were challenge pages', async () => {
    const page = op('getRoot', 'GET', '/', {
      url: 'https://x.test/',
      resourceType: 'document',
      responseBody: textBody('<html><title>Just a moment...</title></html>'),
    })
    page.kind = 'page'
    page.exchanges = page.exchanges.map(item => ({ ...item, kind: 'bot-protection' }))
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [page],
    })
    expect(report.operations).toEqual([])
    expect(report.skipped).toEqual([
      { operationId: 'getRoot', reason: 'no successful response was captured' },
    ])
  })
})

describe('probeOperations: failures and data-changing requests', () => {
  it('says the host is unreachable instead of blaming the session', async () => {
    // A port that was just free: nothing listens there.
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise(resolve => closed.close(resolve))
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        op('getDown', 'GET', '/api/x', {
          url: `http://127.0.0.1:${port}/api/x`,
          responseBody: jsonBody({ a: 1 }),
        }),
      ],
    })
    expect(report.operations[0]).toMatchObject({ replay: 'failed', bare: 'skipped', requires: null })
    expect(report.operations[0]?.note).toMatch(/Could not reach .*ECONNREFUSED/)
    expect(report.operations[0]?.note).not.toContain('expired')
  })

  it('sends an allowed POST exactly once: never bare, never during minimization', async () => {
    const before = requests
    const report = await probeOperations({
      toolVersion: 'test',
      config: { ...config, unsafeMethods: true },
      operations: [
        op('postOpen', 'POST', '/api/open', {
          method: 'POST',
          url: `${origin}/api/open`,
          cookies: { sid: 'good', theme: 'dark' },
          responseBody: jsonBody({
            items: [1],
          }),
        }),
      ],
    })
    expect(requests - before).toBe(1)
    expect(report.operations[0]).toMatchObject({ bare: 'skipped', requires: null })
    expect(report.operations[0]?.note).toContain('replayed once only')
  })

  it('never replays GETs whose path suggests they change state', async () => {
    const before = requests
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        op('getLogout', 'GET', '/account/logout', {
          url: `${origin}/account/logout`,
          responseBody: textBody('<html>bye</html>'),
        }),
      ],
    })
    expect(requests).toBe(before)
    expect(report.skipped[0]?.reason).toContain('changes state')
  })
})

describe('probeOperations: GraphQL (decision 0027)', () => {
  function graphqlOp(operationId: string, operationType: NonNullable<Operation['graphql']>['operationType'], method = 'POST'): Operation {
    return {
      ...op(operationId, method, `/graphql#${operationId}`, {
        method,
        url: method === 'GET'
          ? `${origin}/graphql?operationName=${operationId}`
          : `${origin}/graphql`,
        requestBody: method === 'GET'
          ? null
          : jsonBody({ operationName: operationId, variables: {} }),
        responseBody: jsonBody({
          data: { a: 1 },
        }),
      }),
      graphql: {
        endpoint: '/graphql',
        operationName: operationId,
        operationType,
        operationTypeFrom: operationType === 'unknown'
          ? null
          : 'document',
        persistedQuery: null,
        hashes: [],
        document: null,
        batched: false,
        sent: {
          body: ['operationName', 'variables'],
          query: [],
        },
      },
    }
  }

  it('replays queries sent with POST like GETs, bare and minimized', async () => {
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        graphqlOp('ProductStock', 'query'),
      ],
    })
    expect(report.skipped).toEqual([])
    expect(report.operations[0]).toMatchObject({
      operationId: 'ProductStock',
      replay: 'ok',
      bare: 'ok',
      requires: [],
    })
  })

  it('skips mutations and operations of unknown type unless --unsafe-methods, and then sends them once', async () => {
    const operations = [
      graphqlOp('AddToWishlist', 'mutation'),
      graphqlOp('getAlbum', 'unknown'),
    ]
    const safe = await probeOperations({ toolVersion: 'test', config, operations })
    expect(safe.operations).toEqual([])
    expect(safe.skipped).toEqual([
      { operationId: 'AddToWishlist', reason: 'GraphQL mutation AddToWishlist can change data; pass --unsafe-methods to include it' },
      {
        operationId: 'getAlbum',
        reason: expect.stringMatching(/^GraphQL operation getAlbum has an unknown type .*--unsafe-methods/),
      },
    ])
    const before = requests
    const unsafe = await probeOperations({
      toolVersion: 'test',
      config: { ...config, unsafeMethods: true },
      operations,
    })
    expect(requests - before).toBe(2)
    expect(unsafe.operations.map(result => [result.operationId, result.bare, result.note])).toEqual([
      [
        'AddToWishlist',
        'skipped',
        expect.stringContaining('GraphQL mutation was replayed once only'),
      ],
      [
        'getAlbum',
        'skipped',
        expect.stringContaining('GraphQL operation of unknown type was replayed once only'),
      ],
    ])
  })

  it('never replays a mutation whose type came from the site\'s code', async () => {
    const [typed] = applyGraphqlTypes([
      {
        ...graphqlOp('saveRecentSearches', 'unknown'),
        operationId: 'saveRecentSearches',
      },
    ], new Map([
      [
        `${new URL(origin).host} saveRecentSearches`,
        ['mutation'],
      ],
    ]))
    expect(typed?.graphql).toMatchObject({ operationType: 'mutation', operationTypeFrom: 'source' })
    const before = requests
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: typed
        ? [typed]
        : [],
    })
    expect(requests - before).toBe(0)
    expect(report.operations).toEqual([])
    expect(report.skipped).toEqual([
      { operationId: 'saveRecentSearches', reason: 'GraphQL mutation saveRecentSearches can change data; pass --unsafe-methods to include it' },
    ])
  })

  it('never replays subscriptions, and treats a mutation sent with GET as a mutation', async () => {
    const report = await probeOperations({
      toolVersion: 'test',
      config: { ...config, unsafeMethods: true },
      operations: [
        graphqlOp('OnTick', 'subscription'),
        graphqlOp('Rename', 'mutation', 'GET'),
      ],
    })
    expect(report.skipped).toEqual([
      { operationId: 'OnTick', reason: 'GraphQL subscription OnTick: it streams over a long-lived connection, so it is never replayed' },
    ])
    expect(report.operations[0]).toMatchObject({ operationId: 'Rename', bare: 'skipped' })
  })
})

describe('probeOperations: dispatcher functions (decision 0039)', () => {
  function dispatchOp(value: string, method: string): Operation {
    return {
      ...op(value, method, `/rpc#${value}`, {
        method,
        url: `${origin}/rpc?fn=${value}`,
        responseBody: jsonBody({ a: 1 }),
      }),
      dispatch: {
        endpoint: '/rpc',
        parameter: 'fn',
        in: 'query',
        value,
        values: [value],
      },
    }
  }

  it('never replays a GET function whose name has a state-changing word in it', async () => {
    const changing = [
      'add_to_cart',
      'add-to-cart',
      'addToCart',
      'wc_empty_cart',
      'clearCache',
      'post.like',
      'unlike',
      'vote',
      'followUser',
      'unfollow',
      'purchase',
      'checkout',
      'placeOrder',
      'pay',
      'sendMessage',
      'submitForm',
      'applyCoupon',
      'logout',
      'log_out',
      'signout',
      'resetFilters',
      'subscribe',
      'unsubscribe',
      'trash_post',
    ]
    const safe = [
      'getOrders',
      'getSymbolData',
      'likely',
      'getCart',
    ]
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        ...changing,
        ...safe,
      ].map(value => dispatchOp(value, 'GET')),
    })
    expect(report.skipped.map(entry => entry.operationId).sort()).toEqual([...changing].sort())
    expect(report.skipped.find(entry => entry.operationId === 'addToCart')?.reason).toBe('dispatcher function addToCart suggests it changes state (add to cart, subscribe, delete...), so it is never replayed')
    expect(report.operations.map(result => result.operationId).sort()).toEqual([...safe].sort())
  })

  it('never replays a POST function on its name alone, nor a GET one whose name changes state', async () => {
    const before = requests
    const report = await probeOperations({
      toolVersion: 'test',
      config,
      operations: [
        dispatchOp('getQuote', 'POST'),
        dispatchOp('deletePost', 'GET'),
      ],
    })
    expect(requests).toBe(before)
    expect(report.skipped).toEqual([
      {
        operationId: 'deletePost',
        reason: expect.stringContaining('changes state'),
      },
      { operationId: 'getQuote', reason: 'POST dispatcher function getQuote can change data (its name is no evidence it only reads); pass --unsafe-methods to include it' },
    ])
  })
})
