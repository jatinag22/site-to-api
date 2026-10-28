import type { SessionMeta } from '../model'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SiteToApiError } from '../errors'
import { RAW_FORMAT_VERSION } from '../model'
import { countSessions, loadSessions } from './index'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')

interface EntryInit {
  method?: string
  url: string
  at?: number
  requestHeaders?: Array<[string, string]>
  postData?: { mimeType: string, text?: string, params?: Array<{ name: string, value?: string }> }
  status?: number
  responseHeaders?: Array<[string, string]>
  responseCookies?: Array<{ name: string, value: string }>
  content?: { mimeType?: string, text?: string, encoding?: string }
  resourceType?: string
}

function entry(init: EntryInit): Record<string, unknown> {
  return {
    startedDateTime: new Date(init.at ?? T0).toISOString(),
    ...(init.resourceType
      ? { _resourceType: init.resourceType }
      : {}),
    request: {
      method: init.method ?? 'GET',
      url: init.url,
      headers: (init.requestHeaders ?? []).map(([name, value]) => ({ name, value })),
      cookies: [],
      ...(init.postData
        ? { postData: init.postData }
        : {}),
    },
    response: {
      status: init.status ?? 200,
      statusText: 'OK',
      headers: (init.responseHeaders ?? []).map(([name, value]) => ({ name, value })),
      cookies: init.responseCookies ?? [],
      content: { size: 0, ...init.content },
    },
  }
}

function meta(sessionId: string, startedAt: string): SessionMeta {
  return {
    formatVersion: RAW_FORMAT_VERSION,
    sessionId,
    toolVersion: '0.0.0',
    startUrl: 'https://shop.test/',
    startedAt,
    completedAt: startedAt,
    browser: { channel: null, headless: true, userAgent: 'test' },
    har: 'traffic.har',
    events: 'events.jsonl',
    scripts: [],
  }
}

let root: string

async function writeSession(name: string, sessionMeta: unknown, entries: unknown[], events: string[]): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'meta.json'), JSON.stringify(sessionMeta))
  await writeFile(join(dir, 'traffic.har'), JSON.stringify({
    log: { version: '1.2', entries },
  }))
  await writeFile(join(dir, 'events.jsonl'), events.join('\n'))
}

function requestEvent(init: { url: string, method?: string, ts: number, bodyPreview?: string | null, fn: string, via?: string }): string {
  return JSON.stringify({
    t: 'request',
    ts: init.ts,
    pageUrl: 'https://shop.test/',
    via: init.via ?? 'fetch',
    method: init.method ?? 'GET',
    url: init.url,
    bodyPreview: init.bodyPreview ?? null,
    stack: [
      {
        url: 'https://shop.test/app.js',
        line: 1,
        column: 1,
        functionName: init.fn,
      },
    ],
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'site-to-api-load-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('loadSessions', () => {
  it('throws an actionable error when the raw folder is missing or empty', async () => {
    await expect(loadSessions(join(root, 'missing'))).rejects.toThrow(SiteToApiError)
    await expect(loadSessions(root)).rejects.toThrow(/No capture sessions/)
  })

  it('decodes bodies, headers and cookies', async () => {
    const json = JSON.stringify({
      items: [1, 2],
    })
    await writeSession('s1', meta('s1', '2026-01-01T10:00:00.000Z'), [
      entry({
        url: 'https://shop.test/api/items?page=2#top',
        requestHeaders: [
          [':authority', 'shop.test'],
          ['Accept', 'application/json'],
          ['Cookie', 'session=abc; theme=dark'],
        ],
        responseHeaders: [
          ['Content-Type', 'text/plain'],
          ['Set-Cookie', 'session=next; Path=/; HttpOnly; Secure; SameSite=Lax\nprefs=1; Domain=shop.test'],
        ],
        // JSON served as text/plain and base64 encoded.
        content: {
          mimeType: 'text/plain; charset=utf-8',
          text: Buffer.from(json).toString('base64'),
          encoding: 'base64',
        },
      }),
    ], [])
    const { exchanges, warnings } = await loadSessions(root)
    expect(warnings).toEqual([])
    const [exchange] = exchanges
    expect(exchange).toMatchObject({
      id: 's1:0',
      seq: 0,
      request: {
        url: 'https://shop.test/api/items?page=2',
        host: 'shop.test',
        path: '/api/items',
        query: [
          { name: 'page', value: '2' },
        ],
        headers: [
          { name: 'accept', value: 'application/json' },
        ],
        cookies: [
          { name: 'session', value: 'abc' },
          { name: 'theme', value: 'dark' },
        ],
        body: null,
      },
      response: {
        headers: [
          { name: 'content-type', value: 'text/plain' },
        ],
        body: {
          mimeType: 'text/plain',
          text: json,
          base64: null,
          json: {
            items: [1, 2],
          },
        },
      },
    })
    expect(exchange!.response.setCookies).toEqual([
      {
        name: 'session',
        value: 'next',
        domain: null,
        path: '/',
        expires: null,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: 'prefs',
        value: '1',
        domain: 'shop.test',
        path: null,
        expires: null,
        httpOnly: false,
        secure: false,
        sameSite: null,
      },
    ])
  })

  it('prefers HAR cookie arrays for Set-Cookie and keeps binary bodies as base64', async () => {
    await writeSession('s1', meta('s1', '2026-01-01T10:00:00.000Z'), [
      entry({
        url: 'https://shop.test/logo.png',
        responseCookies: [
          { name: 'a', value: '1' },
        ],
        responseHeaders: [
          ['set-cookie', 'ignored=1'],
        ],
        content: { mimeType: 'image/png', text: 'iVBORw0KGgo=', encoding: 'base64' },
      }),
    ], [])
    const [exchange] = (await loadSessions(root)).exchanges
    expect(exchange!.response.setCookies.map(cookie => cookie.name)).toEqual(['a'])
    expect(exchange!.response.body).toMatchObject({ mimeType: 'image/png', text: null, base64: 'iVBORw0KGgo=' })
    expect(exchange!.resourceType).toBe('image')
  })

  it('parses urlencoded, multipart and XSSI-prefixed JSON bodies', async () => {
    const boundary = '----x'
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      '',
      'Hello',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      'Content-Type: text/plain',
      '',
      'file contents',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    await writeSession('s1', meta('s1', '2026-01-01T10:00:00.000Z'), [
      entry({
        method: 'POST',
        url: 'https://shop.test/login',
        postData: { mimeType: 'application/x-www-form-urlencoded', text: 'user=a%40b.test&remember=1' },
      }),
      entry({
        method: 'POST',
        url: 'https://shop.test/upload',
        at: T0 + 1,
        postData: { mimeType: `multipart/form-data; boundary=${boundary}`, text: multipart },
      }),
      entry({
        method: 'POST',
        url: 'https://shop.test/x',
        at: T0 + 2,
        postData: { mimeType: 'text/plain', text: '{"a":1}' },
        content: { mimeType: 'application/json', text: ')]}\'\n{"ok":true}' },
      }),
    ], [])
    const [login, upload, x] = (await loadSessions(root)).exchanges
    expect(login!.request.body!.form).toEqual([
      { name: 'user', value: 'a@b.test' },
      { name: 'remember', value: '1' },
    ])
    expect(upload!.request.body!.form).toEqual([
      { name: 'title', value: 'Hello' },
      { name: 'file', value: 'a.txt' },
    ])
    expect(x!.request.body!.json).toEqual({ a: 1 })
    expect(x!.response.body!.json).toEqual({ ok: true })
  })

  it('attaches initiators by method, URL and time, using the body preview to break ties', async () => {
    await writeSession('s1', meta('s1', '2026-01-01T10:00:00.000Z'), [
      entry({
        url: 'https://shop.test/',
        resourceType: 'document',
        content: { mimeType: 'text/html', text: '<html></html>' },
      }),
      entry({
        method: 'POST',
        url: 'https://shop.test/api/q',
        at: T0 + 100,
        postData: { mimeType: 'application/json', text: '{"q":"b"}' },
      }),
      entry({
        method: 'POST',
        url: 'https://shop.test/api/q',
        at: T0 + 100,
        postData: { mimeType: 'application/json', text: '{"q":"a"}' },
      }),
      entry({ url: 'https://shop.test/api/late', at: T0 + 10_000 }),
    ], [
      requestEvent({
        method: 'POST',
        url: '/api/q',
        ts: T0 + 99,
        bodyPreview: '{"q":"a"}',
        fn: 'sendA',
      }),
      requestEvent({
        method: 'POST',
        url: 'https://shop.test/api/q',
        ts: T0 + 99,
        bodyPreview: '{"q":"b"}',
        fn: 'sendB',
        via: 'xhr',
      }),
      requestEvent({ url: 'https://shop.test/api/late', ts: T0, fn: 'tooEarly' }),
    ])
    const { exchanges } = await loadSessions(root)
    const byId = new Map(exchanges.map(exchange => [exchange.id, exchange]))
    expect(byId.get('s1:0')!.initiator).toEqual({ via: 'navigation', stack: [] })
    expect(byId.get('s1:0')!.resourceType).toBe('document')
    expect(byId.get('s1:1')!.initiator!.stack[0]!.functionName).toBe('sendB')
    expect(byId.get('s1:1')!.resourceType).toBe('xhr')
    expect(byId.get('s1:2')!.initiator!.stack[0]!.functionName).toBe('sendA')
    expect(byId.get('s1:2')!.pageUrl).toBe('https://shop.test/')
    // Outside the ±3 s window: no initiator.
    expect(byId.get('s1:3')!.initiator).toBeNull()
  })

  it('falls back to sec-fetch-dest for the resource type', async () => {
    await writeSession('s1', meta('s1', '2026-01-01T10:00:00.000Z'), [
      entry({
        url: 'https://shop.test/a',
        requestHeaders: [
          ['sec-fetch-dest', 'empty'],
        ],
      }),
      entry({
        url: 'https://shop.test/b',
        at: T0 + 1,
        requestHeaders: [
          ['sec-fetch-dest', 'style'],
        ],
      }),
      entry({
        url: 'https://shop.test/c',
        at: T0 + 2,
        requestHeaders: [
          ['sec-fetch-dest', 'iframe'],
        ],
      }),
    ], [])
    const types = (await loadSessions(root)).exchanges.map(exchange => exchange.resourceType)
    expect(types).toEqual(['fetch', 'stylesheet', 'document'])
  })

  it('reports bad event lines, bad HAR entries and invalid sessions as warnings', async () => {
    await writeSession('s1', meta('s1', '2026-01-01T10:00:00.000Z'), [
      entry({ url: 'https://shop.test/ok' }),
      {
        request: { method: 'GET' },
      },
    ], [
      'not json',
      JSON.stringify({ t: 'unknown' }),
      '',
    ])
    await writeSession('broken', { formatVersion: 99 }, [], [])
    await mkdir(join(root, 'unrelated'))
    const { exchanges, sessions, warnings } = await loadSessions(root)
    expect(sessions.map(session => session.meta.sessionId)).toEqual(['s1'])
    expect(exchanges).toHaveLength(1)
    expect(warnings).toHaveLength(5)
    expect(warnings.join('\n')).toMatch(/line 1 skipped/)
    expect(warnings.join('\n')).toMatch(/line 2 skipped/)
    expect(warnings.join('\n')).toMatch(/HAR entry 1 skipped/)
    expect(warnings.join('\n')).toMatch(/meta\.json is invalid/)
    expect(warnings.join('\n')).toMatch(/unrelated: no meta\.json/)
    expect(warnings.join('\n')).toMatch(/broken: meta\.json is invalid/)
    // Warnings end up in the committed AGENT.md: no absolute local paths.
    for (const warning of warnings)
      expect(warning).not.toContain(root)
  })

  it('sorts by session start, then by request time, and numbers seq within each session', async () => {
    await writeSession('b-first', meta('b-first', '2026-01-01T09:00:00.000Z'), [
      entry({ url: 'https://shop.test/2', at: T0 + 50 }),
      entry({ url: 'https://shop.test/1', at: T0 }),
    ], [])
    await writeSession('a-second', meta('a-second', '2026-01-02T09:00:00.000Z'), [
      entry({ url: 'https://shop.test/3' }),
    ], [])
    const { exchanges, sessions } = await loadSessions(root)
    expect(sessions.map(session => session.meta.sessionId)).toEqual(['b-first', 'a-second'])
    expect(exchanges.map(exchange => [exchange.id, exchange.seq])).toEqual([
      ['b-first:1', 0],
      ['b-first:0', 1],
      ['a-second:0', 0],
    ])
  })
})

describe('countSessions', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'site-to-api-count-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('counts folders with a meta.json and ignores other entries', async () => {
    await mkdir(join(root, 'a'))
    await writeFile(join(root, 'a', 'meta.json'), '{}')
    await mkdir(join(root, 'b'))
    await writeFile(join(root, 'b', 'meta.json'), '{}')
    await mkdir(join(root, 'unfinished'))
    await writeFile(join(root, '.gitignore'), '*')
    expect(await countSessions(root)).toBe(2)
  })
})
