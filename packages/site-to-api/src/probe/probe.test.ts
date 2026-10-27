import type { AddressInfo } from 'node:net'
import type { Operation } from '../model'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exchange, jsonBody, textBody } from '../../test/helpers'
import { probeOperations, resemblesCapture } from './probe'

let origin: string
let requests = 0
const server = createServer((req, res) => {
  requests++
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

const config = { maxRps: 10, unsafeMethods: false, timeoutMs: 5000 }

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
    expect(report.operations[0]).toMatchObject({ replay: 'rejected', requires: null })
    expect(report.operations[0]?.note).toContain('not accepted')
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
