import type { Analysis, Exchange, FlowsDocument, Operation } from '../../model'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validate } from '@scalar/openapi-parser'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { exchange, jsonBody, textBody } from '../../../test/helpers'
import { CONFIG, fixtureExchanges, SECRETS } from '../../../test/secret-fixture'
import { API, twoHostAnalysis, WWW } from '../../../test/two-hosts'
import { classifyExchanges } from '../../analyze/classify'
import { buildOperations } from '../../analyze/operations'
import { createRedactor } from '../../analyze/redact'
import { inferOperationSchemas } from '../../analyze/schema'
import { FLOWS_FORMAT_VERSION } from '../../model'
import { buildOpenApiDocuments, writeOpenApiDocuments } from './index'
import { specFileName, toYaml } from './write'

const NO_FLOWS: FlowsDocument = {
  formatVersion: FLOWS_FORMAT_VERSION,
  generatedBy: 'test',
  sessions: [],
  session: [],
  flows: [],
  computedValues: [],
}

function analyse(exchanges: Exchange[], flows: FlowsDocument = NO_FLOWS, mutate: (operations: Operation[]) => Operation[] = list => list): Analysis {
  const { exchanges: classified, botProtection } = classifyExchanges(exchanges, { include: [], exclude: [] })
  const redactor = createRedactor({ exchanges: classified, config: CONFIG })
  const operations = mutate(inferOperationSchemas(buildOperations(classified, { sourceRoutes: [] }), redactor))
  return {
    sessions: [
      ...new Set(exchanges.map(item => item.sessionId)),
    ],
    hosts: [
      ...new Set(operations.map(operation => operation.host)),
    ].sort(),
    operations,
    flows,
    botProtection,
    excerpts: new Map(),
    warnings: [],
  }
}

function page(sessionId = 's1'): Exchange {
  return {
    ...exchange({
      sessionId,
      url: 'https://shop.test/',
      resourceType: 'document',
      responseBody: textBody('<html></html>'),
    }),
    pageUrl: null,
  }
}

function sampleExchanges(): Exchange[] {
  return ['s1', 's2'].flatMap(sessionId => [
    page(sessionId),
    exchange({
      sessionId,
      url: `https://shop.test/api/products/${sessionId === 's1'
        ? 12
        : 13}?currency=INR`,
      requestHeaders: { 'x-app-version': '4.2.0', 'sec-fetch-mode': 'cors', 'authorization': `Bearer tok-${sessionId}-abcdef` },
      cookies: { session: `cookie-${sessionId}-abcdef` },
      responseBody: jsonBody({ id: 12, name: 'Shoe', price: 99.5 }),
    }),
    exchange({
      sessionId,
      method: 'POST',
      url: 'https://shop.test/api/login',
      requestBody: jsonBody({ user: 'u', password: `pw-${sessionId}-123456` }),
      responseBody: jsonBody({ ok: true }),
    }),
    exchange({
      sessionId,
      url: 'https://shop.test/report',
      responseBody: textBody('a,b\n1,2', 'text/csv'),
    }),
    {
      ...exchange({
        sessionId,
        url: 'https://api.shop.test/v1/ping',
        responseBody: jsonBody({ pong: true }),
      }),
      pageUrl: 'https://shop.test/',
    },
  ])
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected an object')
  return Object.fromEntries(Object.entries(value))
}

describe('buildOpenApiDocuments', () => {
  it('writes one valid OpenAPI 3.1 document per host', async () => {
    const documents = buildOpenApiDocuments(analyse(sampleExchanges()))
    expect([
      ...documents.keys(),
    ]).toEqual(['api.shop.test', 'shop.test'])
    // The validator really checks: a document without info and paths fails.
    expect((await validate({ openapi: '3.1.0' })).valid).toBe(false)
    for (const document of documents.values()) {
      const result = await validate(toYaml(document))
      expect(result.errors ?? []).toEqual([])
      expect(result.valid).toBe(true)
    }
  })

  it('follows the output format conventions', () => {
    const document = parse(toYaml(buildOpenApiDocuments(analyse(sampleExchanges())).get('shop.test')!))
    expect(document.openapi).toBe('3.1.0')
    expect(document.servers).toEqual([
      { url: 'https://shop.test' },
    ])
    expect(Object.keys(document.paths)).toEqual([
      '/',
      '/api/login',
      '/api/products/{productId}',
      '/report',
    ])

    const get = document.paths['/api/products/{productId}'].get
    expect(get.operationId).toBe('getApiProductsByProductId')
    expect(get['x-site-to-api-kind']).toBe('api')
    expect(get.security).toEqual([
      { authorization: [] },
    ])
    expect(document.components.securitySchemes.authorization).toEqual({ type: 'apiKey', in: 'header', name: 'Authorization' })
    expect(get.parameters).toEqual([
      {
        name: 'productId',
        in: 'path',
        required: true,
        // An id in the path stays a string, though it is digits.
        schema: {
          type: 'string',
          examples: ['12', '13'],
        },
      },
      {
        name: 'currency',
        in: 'query',
        required: true,
        schema: {
          'type': 'string',
          'x-constant': true,
          'examples': ['INR'],
        },
      },
      {
        'name': 'x-app-version',
        'in': 'header',
        // Captured on every request, but the client sends the constant itself.
        'required': false,
        'schema': {
          'type': 'string',
          'x-constant': true,
          'examples': ['4.2.0'],
          'default': '4.2.0',
        },
        'x-site-to-api-constant': true,
      },
      {
        name: 'session',
        in: 'cookie',
        required: true,
        schema: { type: 'string' },
      },
    ])
    expect(get.responses['200'].content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['id', 'name', 'price'],
    })
    expect(get.responses['200'].content['application/json'].examples).toEqual({
      example1: {
        value: { id: 12, name: 'Shoe', price: 99.5 },
      },
    })

    expect(document.paths['/'].get['x-site-to-api-kind']).toBe('page')
    expect(document.paths['/'].get.responses['200'].content['text/html']).toEqual({
      schema: { type: 'string' },
    })
    expect(document.paths['/report'].get.responses['200'].content['text/csv']).toEqual({
      schema: { type: 'string' },
    })
    expect(document.paths['/api/login'].post.requestBody.content['application/json'].examples.example1.value.password).toMatch(/^<redacted/)
  })

  it('adds flow origins, computed values, source refs, extraction specs and source-only flags', async () => {
    const flows: FlowsDocument = {
      ...NO_FLOWS,
      flows: [
        {
          id: 'f1',
          name: 'login',
          trigger: { kind: 'submit', label: 'Log in', pageUrl: 'https://shop.test/' },
          seenInSessions: 2,
          steps: [
            {
              id: 's1',
              operationId: 'postApiLogin',
              kind: 'api',
              browserOnly: false,
              summary: 'login',
              sentFrom: null,
              inputs: {
                'body./password': { kind: 'computed', computedId: 'c1' },
                'body./user': { kind: 'user-input', field: 'user' },
              },
              outputs: {},
              observedIn: [],
            },
            {
              id: 's2',
              operationId: 'getApiProductsByProductId',
              kind: 'api',
              browserOnly: false,
              summary: 'product',
              sentFrom: null,
              inputs: {
                'query.currency': { kind: 'constant', value: 'INR' },
              },
              outputs: {},
              observedIn: [],
            },
          ],
        },
      ],
    }
    const ref = {
      file: 'src/api/login.ts',
      line: 10,
      column: 3,
      functionName: 'login',
      original: true,
      excerpt: null,
    }
    const analysis = analyse(sampleExchanges(), flows, operations => [
      ...operations.map((operation) => {
        if (operation.operationId === 'postApiLogin') {
          return {
            ...operation,
            sentFrom: [ref],
          }
        }
        if (operation.path === '/report') {
          return {
            ...operation,
            responses: operation.responses.map(response => ({
              ...response,
              extract: {
                spec: {
                  kind: 'text' as const,
                  layout: 'delimited' as const,
                  delimiter: ',',
                  header: true,
                  pattern: null,
                  fields: {},
                },
                samples: 2,
                confidence: 'high' as const,
              },
            })),
          }
        }
        return operation
      }),
      {
        ...operations[0]!,
        host: 'shop.test',
        operationId: 'getApiHidden',
        path: '/api/hidden/{id}',
        method: 'GET',
        kind: 'api',
        sourceOnly: true,
        methodUnknown: true,
        exchanges: [],
        responses: [],
        query: [],
        headers: [],
        cookies: [],
        pathParams: [
          {
            name: 'id',
            index: 2,
            schema: { type: 'string' },
            evidence: ['source-template'],
          },
        ],
      },
    ])
    const document = parse(toYaml(buildOpenApiDocuments(analysis).get('shop.test')!))
    const login = document.paths['/api/login'].post
    expect(login['x-site-to-api-source']).toEqual([
      { file: 'src/api/login.ts', line: 10, function: 'login' },
    ])
    const properties = login.requestBody.content['application/json'].schema.properties
    expect(properties.password['x-site-to-api-computed']).toBe('c1')
    expect(properties.user['x-site-to-api-origin']).toEqual({ kind: 'user-input', field: 'user' })
    const currency = document.paths['/api/products/{productId}'].get.parameters.find((param: { name: string }) => param.name === 'currency')
    expect(currency['x-site-to-api-origin']).toEqual({ kind: 'constant', value: 'INR' })
    expect(document.paths['/report'].get.responses['200'].content['text/csv']['x-site-to-api-extract']).toMatchObject({ kind: 'text', delimiter: ',' })
    const hidden = document.paths['/api/hidden/{id}'].get
    expect(hidden['x-site-to-api-source-only']).toBe(true)
    expect(hidden['x-site-to-api-method-unknown']).toBe(true)
    expect(login['x-site-to-api-method-unknown']).toBeUndefined()
    expect(hidden.responses).toEqual({
      default: { description: 'Not observed during capture.' },
    })
    expect((await validate(toYaml(buildOpenApiDocuments(analysis).get('shop.test')!))).valid).toBe(true)
  })

  it('is byte-for-byte deterministic', () => {
    const first = [
      ...buildOpenApiDocuments(analyse(sampleExchanges())).values(),
    ].map(toYaml)
    const second = [
      ...buildOpenApiDocuments(analyse(sampleExchanges())).values(),
    ].map(toYaml)
    expect(second).toEqual(first)
    expect(first.join('')).not.toContain('&a1')
  })

  it('never writes a fixture secret into a spec', async () => {
    const documents = buildOpenApiDocuments(analyse([
      page('s1'),
      ...fixtureExchanges(),
    ]))
    const yaml = [
      ...documents.values(),
    ].map(toYaml).join('\n')
    for (const secret of Object.values(SECRETS)) {
      expect(yaml).not.toContain(String(secret))
      expect(yaml).not.toContain(encodeURIComponent(String(secret)))
    }
    expect(yaml).not.toContain('9876543210')
    for (const document of documents.values())
      expect((await validate(toYaml(document))).valid).toBe(true)
  })

  it('skips methods OpenAPI cannot describe and records them, and uses http when the site did', () => {
    const analysis = analyse([
      {
        ...exchange({
          url: 'http://legacy.test/',
          resourceType: 'document',
          responseBody: textBody('<html>'),
        }),
        pageUrl: null,
      },
      {
        ...exchange({
          method: 'PROPFIND',
          url: 'http://legacy.test/dav',
          responseBody: textBody('<x/>', 'application/xml'),
        }),
        pageUrl: 'http://legacy.test/',
      },
    ])
    const document = asRecord(buildOpenApiDocuments(analysis).get('legacy.test'))
    expect(document.servers).toEqual([
      { url: 'http://legacy.test' },
    ])
    expect(document['x-site-to-api-unsupported-methods']).toEqual(['PROPFIND /dav'])
  })
})

describe('operation ids shared by two hosts', () => {
  it('gives each host the origins of its own steps', () => {
    const documents = buildOpenApiDocuments(twoHostAnalysis())
    const parameters = (host: string): unknown => {
      const yaml: unknown = parse(toYaml(documents.get(host) ?? {}))
      return yaml
    }
    expect(parameters(WWW)).toMatchObject({
      paths: {
        '/': {
          get: {
            parameters: [
              {
                'name': 'lang',
                'x-site-to-api-origin': { kind: 'user-input', field: 'lang' },
              },
            ],
          },
        },
      },
    })
    expect(parameters(API)).toMatchObject({
      paths: {
        '/': {
          get: {
            parameters: [
              {
                'name': 'lang',
                'x-site-to-api-origin': { kind: 'constant', value: 'en' },
              },
              { 'name': 'x-sig', 'x-site-to-api-computed': 'c1' },
              {
                'name': 'x-token',
                'x-site-to-api-origin': {
                  kind: 'step',
                  step: 's1',
                  output: 'body./token',
                  transform: 'none',
                },
              },
            ],
          },
        },
      },
    })
  })
})

describe('required headers', () => {
  it('requires a header only when probe proved it is needed', () => {
    const call = (sessionId: string) => exchange({
      sessionId,
      url: 'https://shop.test/api/latest',
      requestHeaders: { 'x-fetch-nonce': `n-${sessionId}`, 'x-api-key': `k-${sessionId}`, 'sentry-trace': `t-${sessionId}` },
      responseBody: jsonBody({ ok: true }),
    })
    const headersOf = (requires: string[] | null) => {
      const analysis = analyse([
        page(),
        call('s1'),
        call('s2'),
      ], NO_FLOWS, operations => operations.map(operation => ({ ...operation, requires })))
      const document = buildOpenApiDocuments(analysis).get('shop.test') as { paths: Record<string, Record<string, { parameters: Array<{ name: string, in: string, required: boolean }> }>> }
      return document.paths['/api/latest']!.get!.parameters
        .filter(parameter => parameter.in === 'header')
        .map(parameter => [parameter.name, parameter.required])
    }
    // Before probe, and when probe found nothing needed: sent every time, required never.
    expect(headersOf(null)).toEqual([
      ['x-fetch-nonce', false],
      ['x-api-key', false],
      ['sentry-trace', false],
    ])
    expect(headersOf([])).toEqual([
      ['x-fetch-nonce', false],
      ['x-api-key', false],
      ['sentry-trace', false],
    ])
    expect(headersOf(['header:x-api-key', 'header:sentry-trace'])).toEqual([
      ['x-fetch-nonce', false],
      ['x-api-key', true],
      ['sentry-trace', false],
    ])
  })
})

describe('request body media type', () => {
  it('writes JSON text sent under another content type as application/json with the sent type', () => {
    const algoliaBody = {
      mimeType: 'application/x-www-form-urlencoded',
      text: '{"query":"a"}',
      base64: null,
      json: { query: 'a' },
      form: [
        { name: '{"query":"a"}', value: '' },
      ],
    }
    const analysis = analyse([
      page(),
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/search',
        requestBody: algoliaBody,
        responseBody: jsonBody({ hits: [] }),
      }),
    ])
    const document = buildOpenApiDocuments(analysis).get('shop.test') as { paths: Record<string, Record<string, { requestBody: { content: Record<string, Record<string, unknown>> } }>> }
    const content = document.paths['/api/search']!.post!.requestBody.content
    expect(Object.keys(content)).toEqual(['application/json'])
    expect(content['application/json']!['x-site-to-api-content-type']).toBe('application/x-www-form-urlencoded')
  })
})

describe('request body origins', () => {
  it('never writes through a field named __proto__ into Object.prototype', () => {
    const analysis = analyse([
      page(),
      exchange({
        method: 'POST',
        url: 'https://shop.test/api/x',
        requestBody: jsonBody({ a: 1 }),
        responseBody: jsonBody({ ok: true }),
      }),
    ], {
      ...NO_FLOWS,
      flows: [
        {
          id: 'f',
          name: 'f',
          trigger: { kind: 'load', label: 'f', pageUrl: 'https://shop.test/' },
          seenInSessions: 1,
          steps: [
            {
              id: 's1',
              operationId: 'postApiX',
              kind: 'api',
              browserOnly: false,
              summary: '',
              sentFrom: null,
              inputs: {
                'body./__proto__': { kind: 'user-input', field: 'x' },
                'body./constructor/prototype': { kind: 'user-input', field: 'y' },
              },
              outputs: {},
              observedIn: [],
            },
          ],
        },
      ],
    })
    expect(analysis.operations.map(operation => operation.operationId)).toContain('postApiX')
    buildOpenApiDocuments(analysis)
    const probe: Record<string, unknown> = {}
    expect(probe['x-site-to-api-origin']).toBeUndefined()
    expect(Object.hasOwn(Object.prototype, 'x-site-to-api-origin')).toBe(false)
  })
})

describe('writeOpenApiDocuments', () => {
  it('writes specs/<host>.yaml with safe file names and returns the paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-to-api-openapi-'))
    try {
      const documents = new Map<string, object>([
        [
          'localhost:3000',
          { openapi: '3.1.0' },
        ],
        [
          'a.test',
          { openapi: '3.1.0' },
        ],
      ])
      const written = await writeOpenApiDocuments(dir, documents)
      expect(written).toEqual([
        join(dir, 'specs', 'a.test.yaml'),
        join(dir, 'specs', 'localhost_3000.yaml'),
      ])
      expect(await readFile(written[1]!, 'utf8')).toBe('openapi: 3.1.0\n')
      expect(specFileName('x.test:8080')).toBe('x.test_8080.yaml')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
