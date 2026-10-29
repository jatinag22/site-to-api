import type { AddressInfo } from 'node:net'
import type { Operation } from '../model'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exchange, jsonBody, textBody } from '../../test/helpers'
import { applyGraphqlTypes } from '../analyze/graphql'
import { probeOperations, resemblesCapture } from './probe'

let origin: string
let requests = 0
const userAgents: string[] = []
const clientHints: string[] = []
function challenge(res: import('node:http').ServerResponse): void {
  res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge', 'server': 'cloudflare' }).end('<title>Just a moment...</title>')
}
const server = createServer((req, res) => {
  requests++
  if (req.url === '/api/tags') {
    // As Cloudflare did on Stack Overflow: the `HeadlessChrome` token alone gets a challenge.
    userAgents.push(req.headers['user-agent'] ?? '')
    clientHints.push(String(req.headers['sec-ch-ua'] ?? ''))
    if ((req.headers['user-agent'] ?? '').includes('HeadlessChrome')) {
      challenge(res)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}')
    return
  }
  if (req.url === '/api/walled') {
    challenge(res)
    return
  }
  if (req.url === '/api/teapot') {
    res.writeHead(419, { 'content-type': 'application/json' }).end('{"error":"page expired"}')
    return
  }
  if (req.url === '/api/login-only') {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"login"}')
    return
  }
  const cookie = req.headers.cookie ?? ''
  if (req.url === '/api/open') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[1]}')
    return
  }
  if (req.url === '/api/private') {
    const ok = cookie.includes('sid=good') && req.headers['x-api-key'] === 'k1'
    res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }).end(ok ? '{"items":[1],"total":1}' : '{"error":"forbidden"}')
    return
  }
  if (req.url?.startsWith('/graphql')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"a":1}}')
    return
  }
  if (req.url === '/api/challenge') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>checking your browser</html>')
    return
  }
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

  it('tells bot protection, a refused session and other statuses apart', async () => {
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
    expect(byId.get('getTeapot')).toMatchObject({
      rejection: 'other',
      statuses: [419, 419],
    })
    expect(byId.get('getTeapot')?.note).toContain('status 419, captured 200')
    expect(byId.get('getTeapot')?.note).not.toContain('not accepted')
    expect(byId.get('getLoginOnly')).toMatchObject({
      rejection: 'session',
      statuses: [401, 401],
    })
    expect(byId.get('getLoginOnly')?.note).toContain('not accepted any more (status 401, 401')
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
