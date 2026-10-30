import type { Operation, ResponseInfo } from '../model'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exchange, jsonBody } from '../../test/helpers'
import { SiteToApiError } from '../errors'
import { checkOperations, exitCodeFor, readCheckReport, summarizeCheck, writeCheckReport } from './index'

const config = {
  maxRps: 10,
  unsafeMethods: false,
  timeoutMs: 5000,
  minimizePerHost: 5,
}
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const response200: ResponseInfo = {
  status: 200,
  mimeType: 'application/json',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
    },
    required: ['id', 'name'],
  },
  extract: null,
  examples: [],
}

function op(operationId: string, method = 'GET', path = `/api/${operationId}`, extra: Partial<Operation> = {}): Operation {
  return {
    operationId,
    host: 'shop.test',
    method,
    path,
    kind: 'api',
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses: [response200],
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges: [
      exchange({
        method,
        url: `https://shop.test${path}`,
        responseBody: jsonBody({ id: 1, name: 'a' }),
      }),
    ],
    ...extra,
  }
}

function fakeFetch(answers: Record<string, () => Response>): { fetch: typeof fetch, calls: Array<{ url: string, method: string, headers: Headers }> } {
  const calls: Array<{ url: string, method: string, headers: Headers }> = []
  return {
    calls,
    fetch: async (input, init) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
      })
      const answer = answers[new URL(url).pathname]
      if (!answer) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        })
      }
      return answer()
    },
  }
}

function json(status: number, body: unknown) {
  return (): Response => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function run(operations: Operation[], answers: Record<string, () => Response>, extra: { operationIds?: string[], redactText?: (text: string) => string, staleInputs?: ReadonlyMap<string, readonly string[]>, skippedHosts?: string[] } = {}) {
  const site = fakeFetch(answers)
  const report = await checkOperations({
    operations,
    config,
    toolVersion: 'test',
    fetch: site.fetch,
    sleep: async () => {},
    ...extra,
  })
  return { report, calls: site.calls }
}

describe('checkOperations', () => {
  it('reports ok when the live answer matches, with exit code 0', async () => {
    const { report } = await run([
      op('items'),
    ], {
      '/api/items': json(200, { id: 2, name: 'b' }),
    })
    expect(report.operations).toMatchObject([
      {
        operationId: 'items',
        verdict: 'ok',
        added: [],
        removed: [],
        typeChanged: [],
      },
    ])
    expect(report.exitCode).toBe(0)
  })

  it('reports added, removed and retyped fields and exits 1', async () => {
    const { report } = await run([
      op('added'),
      op('lost'),
      op('typed'),
    ], {
      '/api/added': json(200, { id: 1, name: 'a', badge: 'new' }),
      '/api/lost': json(200, { id: 1 }),
      '/api/typed': json(200, { id: '1', name: 'a' }),
    })
    const byId = Object.fromEntries(report.operations.map(entry => [entry.operationId, entry]))
    expect(byId.added).toMatchObject({
      verdict: 'drift',
      added: ['$.badge'],
    })
    expect(byId.lost).toMatchObject({
      verdict: 'drift',
      removed: ['$.name'],
    })
    expect(byId.typed).toMatchObject({
      verdict: 'drift',
      typeChanged: [
        { path: '$.id', expected: 'integer', actual: 'string' },
      ],
    })
    expect(report.exitCode).toBe(1)
  })

  it('reports a status change as drift', async () => {
    const { report } = await run([
      op('gone'),
    ], {
      '/api/gone': json(404, { error: 'not found' }),
    })
    expect(report.operations[0]).toMatchObject({
      verdict: 'drift',
      status: { expected: 200, actual: 404 },
      note: 'status 404, captured 200',
    })
    expect(report.exitCode).toBe(1)
  })

  it('classifies bot protection and a refused session as blocked, not drift, and exits 2', async () => {
    const { report } = await run([
      op('walled'),
      op('login'),
    ], {
      '/api/walled': () => new Response('<title>Just a moment...</title>', {
        status: 403,
        headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
      }),
      '/api/login': () => new Response('{"error":"login"}', {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      }),
    })
    const byId = Object.fromEntries(report.operations.map(entry => [entry.operationId, entry]))
    expect(byId.walled).toMatchObject({ verdict: 'blocked', rejection: 'bot-protection' })
    expect(byId.login).toMatchObject({ verdict: 'blocked', rejection: 'session' })
    expect(report.exitCode).toBe(2)
  })

  it('reports an unreachable site and exits 2', async () => {
    const { report } = await run([
      op('down'),
    ], {})
    expect(report.operations[0]).toMatchObject({
      verdict: 'unreachable',
      status: { expected: 200, actual: null },
    })
    expect(report.operations[0]?.note).toContain('ECONNREFUSED')
    expect(report.exitCode).toBe(2)
  })

  it('lets drift win over a gap in the exit code', async () => {
    const { report } = await run([
      op('down'),
      op('gone'),
    ], {
      '/api/gone': json(500, {}),
    })
    expect(report.exitCode).toBe(1)
  })

  it('never sends a request that can change data, even for unsafe operations asked for by id', async () => {
    const post = op('create', 'POST', '/api/create')
    const { report, calls } = await run([
      post,
      op('items'),
    ], {
      '/api/items': json(200, { id: 1, name: 'a' }),
      '/api/create': json(200, { id: 1, name: 'a' }),
    }, {
      operationIds: ['create', 'items'],
    })
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(report.skipped).toEqual([
      { operationId: 'create', reason: 'POST can change data; pass --unsafe-methods to include it', cause: 'safety' },
    ])
  })

  it('skips bot-protection steps and operations seen in code only', async () => {
    const { report, calls } = await run([
      op('shield', 'GET', '/shield', { kind: 'bot-protection' }),
      op('related', 'GET', '/related', { sourceOnly: true }),
    ], {})
    expect(calls).toEqual([])
    expect(report.skipped.map(entry => entry.operationId)).toEqual(['related', 'shield'])
    expect(report.exitCode).toBe(2)
  })

  it('sends probe\'s identity: its own user agent, never the capture browser\'s', async () => {
    const operation = op('items', 'GET', '/api/items', {
      exchanges: [
        exchange({
          url: 'https://shop.test/api/items',
          requestHeaders: { 'user-agent': 'HeadlessChrome/1', 'sec-ch-ua': '"x"' },
          responseBody: jsonBody({ id: 1, name: 'a' }),
        }),
      ],
    })
    const { calls } = await run([operation], {
      '/api/items': json(200, { id: 1, name: 'a' }),
    })
    expect(calls[0]?.headers.get('user-agent')).toBe('site-to-api/test (probe; automated)')
    expect(calls[0]?.headers.has('sec-ch-ua')).toBe(false)
  })

  it('waits between requests', async () => {
    const waits: number[] = []
    let clock = 0
    await checkOperations({
      operations: [
        op('a'),
        op('b'),
      ],
      config: { ...config, maxRps: 1 },
      toolVersion: 'test',
      fetch: fakeFetch({
        '/api/a': json(200, { id: 1, name: 'a' }),
        '/api/b': json(200, { id: 1, name: 'a' }),
      }).fetch,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms)
        clock += ms
      },
    })
    expect(waits).toEqual([1000])
  })

  it('filters by operation id and rejects an unknown one', async () => {
    const answers = {
      '/api/a': json(200, { id: 1, name: 'a' }),
      '/api/b': json(200, { id: 1, name: 'a' }),
    }
    const { report, calls } = await run([
      op('a'),
      op('b'),
    ], answers, {
      operationIds: ['b'],
    })
    expect(report.operations.map(entry => entry.operationId)).toEqual(['b'])
    expect(calls).toHaveLength(1)
    await expect(run([
      op('a'),
    ], answers, {
      operationIds: ['nope'],
    })).rejects.toBeInstanceOf(SiteToApiError)
  })

  it('redacts free text and holds paths only, never values', async () => {
    const { report } = await run([
      op('items'),
    ], {
      '/api/items': json(200, { 'id': 1, 'name': 'a', 'secret-key-9': 'value-that-must-not-appear' }),
    }, {
      redactText: text => text.replace('secret-key-9', '[redacted]'),
    })
    expect(report.operations[0]?.added).toEqual(['$.[redacted]'])
    expect(JSON.stringify(report)).not.toContain('value-that-must-not-appear')
  })
})

describe('exitCodeFor', () => {
  it('is 2 when nothing was checked', () => {
    expect(exitCodeFor([])).toBe(2)
  })
})

describe('exit code with skipped operations', () => {
  const answers = {
    '/api/ok': json(200, { id: 1, name: 'a' }),
    '/api/gone': json(404, {}),
  }
  const unsafe = (): Operation => op('create', 'POST', '/api/create')
  const noSample = (): Operation => op('empty', 'GET', '/api/empty', {
    exchanges: [
      exchange({ url: 'https://shop.test/api/empty', status: 500 }),
    ],
  })

  it('ignores an operation skipped by a safety rule', async () => {
    const { report } = await run([
      op('ok'),
      unsafe(),
    ], answers)
    expect(report.skipped).toMatchObject([
      { cause: 'safety' },
    ])
    expect(report.exitCode).toBe(0)
  })

  it('is 0 with a note when an operation only lacked a captured success (decision 0052)', async () => {
    const { report } = await run([
      op('ok'),
      noSample(),
    ], answers)
    expect(report.skipped).toMatchObject([
      { operationId: 'empty', cause: 'no-sample' },
    ])
    expect(report.exitCode).toBe(0)
    expect(summarizeCheck(report)).toContain('1 operation(s) had no captured success to replay and were not checked; this does not change the exit code. Capture them working to check them.')
  })

  it('is still 2 when nothing at all was replayed', async () => {
    const { report } = await run([
      noSample(),
    ], answers)
    expect(report.exitCode).toBe(2)
  })

  it('is 2 for an answer the capture documents nothing for', async () => {
    const { report } = await run([
      op('ok'),
      op('bare', 'GET', '/api/bare', { responses: [] }),
    ], {
      ...answers,
      '/api/bare': json(200, { id: 1 }),
    })
    expect(report.operations.find(entry => entry.operationId === 'bare')).toMatchObject({ verdict: 'unchecked' })
    expect(report.exitCode).toBe(2)
    expect(summarizeCheck(report)).toContain('UNCHECKED GET shop.test/api/bare (bare)')
  })

  it('is still 1 when drift is found next to skips and gaps', async () => {
    const { report } = await run([
      op('gone'),
      unsafe(),
      noSample(),
      op('down'),
    ], answers)
    expect(report.exitCode).toBe(1)
  })

  it('names an operation that could not be checked in the summary', async () => {
    const { report } = await run([
      op('ok'),
      noSample(),
    ], answers)
    expect(summarizeCheck(report)).toContain('NOT CHECKED empty')
  })
})

describe('what counts as a refusal', () => {
  it('does not call a normal JSON 200 blocked because a field holds login-form text', async () => {
    const { report } = await run([
      op('items'),
    ], {
      '/api/items': json(200, { id: 1, name: '<form><input type="password" name="pw"></form>' }),
    })
    expect(report.operations[0]).toMatchObject({ verdict: 'ok' })
  })

  it('still calls a login form served where the capture had JSON a refused session', async () => {
    const { report } = await run([
      op('items'),
    ], {
      '/api/items': () => new Response('<form><input type="password"></form>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    })
    expect(report.operations[0]).toMatchObject({ verdict: 'blocked', rejection: 'session' })
  })

  it('does not call a 200 with a JSON body that stopped parsing blocked by the vendor words in it', async () => {
    const { report } = await run([
      op('items'),
    ], {
      '/api/items': () => new Response('not json px-captcha', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    })
    expect(report.operations[0]?.verdict).toBe('drift')
  })
})

describe('graphQL queries', () => {
  const graphqlOp = (operationType: 'query' | 'mutation'): Operation => op(`${operationType}Thing`, 'POST', '/api/graphql#Thing', {
    graphql: {
      endpoint: '/api/graphql',
      operationName: 'Thing',
      operationType,
      operationTypeFrom: 'document',
      persistedQuery: null,
      hashes: [],
      document: null,
      batched: false,
      sent: {
        body: ['query'],
        query: [],
      },
    },
    exchanges: [
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/graphql',
        requestBody: jsonBody({ query: '{ thing { id } }' }),
        responseBody: jsonBody({ id: 1, name: 'a' }),
      }),
    ],
  })

  it('replays a query over POST once, like probe, and leaves a mutation alone', async () => {
    const { report, calls } = await run([
      graphqlOp('query'),
      graphqlOp('mutation'),
    ], {
      '/api/graphql': json(200, { id: 1, name: 'a', extra: true }),
    })
    expect(calls.map(call => call.method)).toEqual(['POST'])
    expect(report.operations).toMatchObject([
      {
        operationId: 'queryThing',
        verdict: 'drift',
        added: ['$.extra'],
      },
    ])
    expect(report.skipped).toMatchObject([
      { operationId: 'mutationThing', cause: 'safety' },
    ])
  })
})

describe('redacting reports', () => {
  it('redacts the reason of a skipped operation', async () => {
    const { report } = await run([
      op('create', 'POST', '/api/create'),
    ], {}, {
      redactText: text => text.replace('POST', '[method]'),
    })
    expect(report.skipped[0]?.reason).toBe('[method] can change data; pass --unsafe-methods to include it')
  })

  it('orders operations by code unit', async () => {
    const answers = {
      '/api/Beta': json(200, { id: 1, name: 'a' }),
      '/api/alpha': json(200, { id: 1, name: 'a' }),
    }
    const { report } = await run([
      op('alpha'),
      op('Beta'),
    ], answers)
    expect(report.operations.map(entry => entry.operationId)).toEqual(['Beta', 'alpha'])
  })
})

describe('check.json', () => {
  it('round-trips and is absent before the first check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-to-api-check-'))
    dirs.push(dir)
    expect(await readCheckReport(dir)).toBeNull()
    const { report } = await run([
      op('items'),
    ], {
      '/api/items': json(200, { id: 1 }),
    })
    await writeCheckReport(dir, report)
    expect(await readCheckReport(dir)).toEqual(report)
    expect(JSON.parse(await readFile(join(dir, 'check.json'), 'utf8'))).toMatchObject({ formatVersion: 1, exitCode: 1 })
  })
})

describe('summarizeCheck', () => {
  it('counts first, then lists every operation that is not ok', async () => {
    const { report } = await run([
      op('ok'),
      op('drifted'),
      op('down'),
    ], {
      '/api/ok': json(200, { id: 1, name: 'a' }),
      '/api/drifted': json(200, { id: '1', name: 'a', extra: true }),
    })
    const lines = summarizeCheck(report)
    expect(lines[0]).toBe('Checked 3 operations: 1 ok, 1 drifted, 0 blocked, 1 unreachable, 0 unchecked; 0 skipped.')
    expect(lines).toContain('DRIFT GET shop.test/api/drifted (drifted)')
    expect(lines).toContain('  added: $.extra')
    expect(lines).toContain('  type: $.id integer -> string')
    expect(lines.some(line => line.startsWith('UNREACHABLE GET shop.test/api/down'))).toBe(true)
    expect(lines.some(line => line.includes('(ok)'))).toBe(false)
  })
})

describe('stale inputs', () => {
  it('reports a drift on an operation with a time-based input as unchecked, not drift', async () => {
    const { report } = await run([
      op('token'),
    ], {
      '/api/token': json(400, { error: 'bad totp' }),
    }, {
      staleInputs: new Map([
        [
          'token',
          ['query.totp'],
        ],
      ]),
    })
    expect(report.operations[0]).toMatchObject({
      verdict: 'unchecked',
      added: [],
      removed: [],
      typeChanged: [],
    })
    expect(report.operations[0]?.note).toContain('query.totp')
    expect(report.exitCode).toBe(2)
  })

  it('still reports ok when the replay works anyway, and drift for operations without such inputs', async () => {
    const stale = new Map([
      [
        'token',
        ['query.totp'],
      ],
    ])
    const { report } = await run([
      op('token'),
      op('gone'),
    ], {
      '/api/token': json(200, { id: 1, name: 'a' }),
      '/api/gone': json(404, {}),
    }, { staleInputs: stale })
    expect(report.operations.map(entry => [entry.operationId, entry.verdict])).toEqual([
      ['gone', 'drift'],
      ['token', 'ok'],
    ])
    expect(report.exitCode).toBe(1)
  })
})

describe('skipped hosts', () => {
  it('records the third-party hosts that were left out, sorted, and prints them', async () => {
    const { report } = await run([
      op('ok'),
    ], {
      '/api/ok': json(200, { id: 1, name: 'a' }),
    }, {
      skippedHosts: ['z.ads.test', 'accounts.google.com'],
    })
    expect(report.skippedHosts).toEqual(['accounts.google.com', 'z.ads.test'])
    expect(summarizeCheck(report)).toContain('Third-party hosts not checked (name one with --include to check it): accounts.google.com, z.ads.test.')
  })
})
