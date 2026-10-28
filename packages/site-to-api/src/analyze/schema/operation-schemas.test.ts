import type { Exchange, Operation } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, formBody, jsonBody, textBody } from '../../../test/helpers'
import { createRedactor } from '../redact'
import { inferOperationSchemas, isBrowserManagedHeader } from './operation-schemas'

function operation(exchanges: Exchange[], init: Partial<Operation> = {}): Operation {
  return {
    operationId: 'op',
    host: 'shop.test',
    method: 'GET',
    path: '/api/x',
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
    ...init,
  }
}

function infer(exchanges: Exchange[], init: Partial<Operation> = {}, examples: 'masked' | 'raw' | 'none' = 'masked', fields: string[] = []): Operation {
  const redactor = createRedactor({
    exchanges,
    config: {
      examples,
      maxExamples: 3,
      patterns: [],
      fields,
    },
  })
  return inferOperationSchemas([
    operation(exchanges, init),
  ], redactor)[0]!
}

describe('inferOperationSchemas', () => {
  it('infers query parameters with types, required flags, examples and repeats', () => {
    const result = infer([
      exchange({ url: 'https://shop.test/api/x?page=1&q=shoes&tag=a&tag=b' }),
      exchange({ url: 'https://shop.test/api/x?page=2&tag=c' }),
    ])
    expect(result.query).toEqual([
      {
        name: 'page',
        required: true,
        schema: {
          type: 'integer',
          examples: [1, 2],
        },
      },
      {
        name: 'q',
        required: false,
        schema: {
          type: 'string',
          examples: ['shoes'],
        },
      },
      {
        name: 'tag',
        required: true,
        schema: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    ])
  })

  it('drops browser-managed headers, flags constants and never defaults a secret', () => {
    const headers = {
      'Host': 'shop.test',
      'sec-fetch-mode': 'cors',
      'sec-ch-ua': 'x',
      'x-app': 'web',
      'x-csrf-token': 'csrf-value-1',
      'referer': 'https://shop.test/',
    }
    const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]))
    // A secret constant across two sessions (a reused profile): the redactor keeps it only because
    // it is identical in every session, so it is a default only through the configured field.
    const result = infer([
      exchange({ url: 'https://shop.test/api/x', requestHeaders: lower, sessionId: 's1' }),
      exchange({
        url: 'https://shop.test/api/x',
        requestHeaders: { ...lower, 'x-extra': '1' },
        sessionId: 's2',
      }),
    ], {}, 'masked', ['x-csrf-token'])
    expect(result.headers.map(header => header.name)).toEqual([
      'x-app',
      'x-csrf-token',
      'referer',
      'x-extra',
    ])
    const [app, csrf, referer, extra] = result.headers
    expect(app).toMatchObject({
      required: true,
      constant: true,
      schema: { type: 'string', default: 'web' },
    })
    expect(csrf!.constant).toBe(true)
    expect(csrf!.schema.default).toBeUndefined()
    expect(csrf!.schema.examples).toEqual(['<redacted: 12 chars>'])
    expect(referer!.schema).toMatchObject({ format: 'uri', default: 'https://shop.test/' })
    expect(extra).toMatchObject({ required: false, constant: false })
    expect(isBrowserManagedHeader('sec-fetch-site')).toBe(true)
    expect(isBrowserManagedHeader('x-sec-fetch')).toBe(false)
  })

  it('treats a header as constant only when two or more sessions agree', () => {
    // One session: a per-session CSRF token from the page repeats on every request of that session.
    const single = infer([
      exchange({
        url: 'https://shop.test/api/x',
        requestHeaders: { 'x-csrf-token': 'per-session-token', 'x-app': 'web' },
      }),
      exchange({
        url: 'https://shop.test/api/x',
        requestHeaders: { 'x-csrf-token': 'per-session-token', 'x-app': 'web' },
      }),
    ])
    for (const header of single.headers) {
      expect(header.constant).toBe(false)
      expect(header.schema.default).toBeUndefined()
      expect(header.schema['x-constant']).toBeUndefined()
    }
    expect(single.headers.find(header => header.name === 'x-csrf-token')?.schema.examples).toEqual(['<redacted: 17 base64 chars>'])
    // Two sessions with the same value: a constant the client can default.
    const two = infer([
      exchange({
        url: 'https://shop.test/api/x',
        requestHeaders: { 'x-app': 'web' },
        sessionId: 's1',
      }),
      exchange({
        url: 'https://shop.test/api/x',
        requestHeaders: { 'x-app': 'web' },
        sessionId: 's2',
      }),
    ])
    expect(two.headers[0]).toMatchObject({
      constant: true,
      schema: { 'default': 'web', 'x-constant': true },
    })
  })

  it('never requires the page context headers a browser adds, even when sent every time', () => {
    const result = infer([
      exchange({
        url: 'https://shop.test/api/x',
        requestHeaders: { 'origin': 'https://shop.test', 'referer': 'https://shop.test/login', 'x-app': 'web' },
      }),
      exchange({
        url: 'https://shop.test/api/x',
        requestHeaders: { 'origin': 'https://shop.test', 'referer': 'https://shop.test/login', 'x-app': 'web' },
      }),
    ])
    expect(result.headers.map(header => [header.name, header.required, header.constant])).toEqual([
      ['origin', false, false],
      ['referer', false, false],
      ['x-app', true, false],
    ])
    expect(result.headers.find(header => header.name === 'referer')?.schema.examples).toEqual(['https://shop.test/login'])
  })

  it('never turns the capture browser\'s identity into constant defaults', () => {
    const identity = {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="156"',
      'x-app': 'web',
    }
    const result = infer([
      exchange({ url: 'https://shop.test/api/x', requestHeaders: identity, sessionId: 's1' }),
      exchange({ url: 'https://shop.test/api/x', requestHeaders: identity, sessionId: 's2' }),
    ])
    expect(result.headers.map(header => header.name)).toEqual(['user-agent', 'accept-language', 'x-app'])
    const [agent, language, app] = result.headers
    for (const header of [agent!, language!]) {
      expect(header.constant).toBe(false)
      expect(header.required).toBe(false)
      expect(header.schema.default).toBeUndefined()
      expect(header.schema['x-constant']).toBeUndefined()
    }
    // Still documented as observed values.
    expect(agent!.schema.examples).toEqual([identity['user-agent']])
    expect(app).toMatchObject({
      constant: true,
      schema: { default: 'web' },
    })
  })

  it('infers query enums only for code-like names and values', () => {
    const urls = [
      'beverages',
      'snacks',
      'beverages',
      'snacks',
    ].map(category => `https://shop.test/api/x?category=${category}&q=${category}`)
    const result = infer(urls.map(url => exchange({ url })))
    expect(result.query.find(param => param.name === 'category')?.schema.enum).toEqual(['beverages', 'snacks'])
    expect(result.query.find(param => param.name === 'q')?.schema.enum).toBeUndefined()
  })

  it('lists cookies by name only', () => {
    const result = infer([
      exchange({
        url: 'https://shop.test/api/x',
        cookies: { session: 'secret-a', theme: 'dark' },
      }),
      exchange({
        url: 'https://shop.test/api/x',
        cookies: { session: 'secret-b' },
      }),
    ])
    expect(result.cookies).toEqual([
      {
        name: 'session',
        required: true,
        schema: { type: 'string' },
      },
      {
        name: 'theme',
        required: false,
        schema: { type: 'string' },
      },
    ])
    expect(JSON.stringify(result.cookies)).not.toContain('secret')
  })

  it('infers JSON request bodies and redacts their examples', () => {
    const result = infer([
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/x',
        requestBody: jsonBody({ email: 'a@b.test', qty: 1 }),
      }),
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/x',
        requestBody: jsonBody({ email: 'c@d.test', qty: 2 }),
      }),
    ])
    expect(result.requestBody).toEqual({
      mimeType: 'application/json',
      schema: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          qty: { type: 'integer' },
        },
        required: ['email', 'qty'],
      },
      examples: [
        { email: 'x@x.xxxx', qty: 1 },
        { email: 'x@x.xxxx', qty: 2 },
      ],
    })
  })

  it('infers form bodies, picking the most common media type', () => {
    const result = infer([
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/x',
        requestBody: formBody({ user: 'u', password: 'p1', remember: '1' }),
      }),
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/x',
        requestBody: formBody({ user: 'v', password: 'p2' }),
      }),
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/x',
        requestBody: jsonBody({ other: true }),
      }),
    ])
    expect(result.requestBody).toEqual({
      mimeType: 'application/x-www-form-urlencoded',
      schema: {
        type: 'object',
        properties: {
          user: { type: 'string' },
          password: { type: 'string' },
          remember: { type: 'integer' },
        },
        required: ['user', 'password'],
      },
      examples: [
        { user: 'u', password: '<redacted: 2 chars>', remember: '1' },
        { user: 'v', password: '<redacted: 2 chars>' },
      ],
    })
  })

  it('handles text and binary request bodies', () => {
    const binary = {
      mimeType: 'application/octet-stream',
      text: null,
      base64: 'AAEC',
      json: undefined,
      form: null,
    }
    expect(infer([
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/x',
        requestBody: textBody('hello', 'text/plain'),
      }),
    ]).requestBody)
      .toEqual({
        mimeType: 'text/plain',
        schema: { type: 'string' },
        examples: ['hello'],
      })
    expect(infer([
      exchange({ method: 'POST', url: 'https://shop.test/api/x', requestBody: binary }),
    ]).requestBody)
      .toEqual({
        mimeType: 'application/octet-stream',
        schema: { type: 'string', format: 'binary' },
        examples: [],
      })
  })

  it('groups responses by status and media type; HTML gets no schema', () => {
    const result = infer([
      exchange({
        url: 'https://shop.test/api/x',
        responseBody: jsonBody({ ok: true }),
      }),
      exchange({
        url: 'https://shop.test/api/x',
        status: 404,
        responseBody: textBody('<h1>no</h1>'),
      }),
      exchange({
        url: 'https://shop.test/api/x',
        responseBody: jsonBody({ ok: false }),
      }),
      exchange({ url: 'https://shop.test/api/x', status: 204 }),
    ])
    expect(result.responses).toEqual([
      {
        status: 200,
        mimeType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
        },
        extract: null,
        examples: [
          { ok: true },
          { ok: false },
        ],
      },
      {
        status: 204,
        mimeType: '',
        schema: null,
        extract: null,
        examples: [],
      },
      {
        status: 404,
        mimeType: 'text/html',
        schema: null,
        extract: null,
        examples: [],
      },
    ])
  })

  it('adds typed, redacted examples to path parameters', () => {
    const result = infer([
      exchange({ url: 'https://shop.test/api/items/12' }),
      exchange({ url: 'https://shop.test/api/items/13' }),
    ], {
      path: '/api/items/{itemId}',
      pathParams: [
        {
          name: 'itemId',
          index: 2,
          schema: { type: 'string' },
          evidence: ['varies'],
        },
      ],
    })
    expect(result.pathParams[0]!.schema).toEqual({
      type: 'integer',
      examples: [12, 13],
    })
  })

  it('writes no examples in none mode and leaves source-only operations untouched', () => {
    const result = infer([
      exchange({
        url: 'https://shop.test/api/x?a=1',
        responseBody: jsonBody([1]),
      }),
    ], {}, 'none')
    expect(result.query[0]!.schema).toEqual({ type: 'integer' })
    expect(result.responses[0]!.examples).toEqual([])
    const sourceOnly = operation([], { sourceOnly: true })
    const redactor = createRedactor({
      exchanges: [],
      config: {
        examples: 'masked',
        maxExamples: 3,
        patterns: [],
        fields: [],
      },
    })
    expect(inferOperationSchemas([sourceOnly], redactor)[0]).toBe(sourceOnly)
  })
})
