import type { OpenApiDocument } from './spec'
import { describe, expect, it } from 'vitest'
import { describeHost, OpenApiDocumentSchema, toIdentifier, toPascalCase, withoutBrowserOnlySteps } from './spec'

const HTML_EXTRACT = {
  kind: 'html',
  records: 'li',
  many: true,
  // What the records are; read through so gen can name the parser after it.
  recordsName: 'items',
  fields: {
    name: {
      selector: '',
      attr: null,
      pattern: null,
      type: 'string',
      optional: false,
    },
  },
}

function doc(paths: Record<string, unknown>, servers: unknown = [
  { url: 'https://api.example.com/' },
]): OpenApiDocument {
  return OpenApiDocumentSchema.parse({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    servers,
    paths,
  })
}

function header(name: string, value: string, constant = true): Record<string, unknown> {
  return {
    'name': name,
    'in': 'header',
    'schema': { type: 'string', default: value },
    'x-site-to-api-constant': constant,
  }
}

describe('describeHost', () => {
  it('reads host, base URL, sorted operation ids and constant headers', () => {
    const warnings: string[] = []
    const host = describeHost('api.example.com.yaml', doc({
      '/b': {
        get: {
          operationId: 'getB',
          parameters: [
            header('X-Client', 'web'),
            header('x-other', 'v', false),
          ],
          responses: {},
        },
      },
      '/a': {
        parameters: [
          header('accept-language', 'en'),
        ],
        post: { operationId: 'postA', responses: {} },
      },
    }), warnings)
    expect(warnings).toEqual([])
    expect(host).toMatchObject({
      host: 'api.example.com',
      identifier: 'api_example_com',
      baseUrl: 'https://api.example.com',
      operationIds: ['getB', 'postA'],
      defaultHeaders: { 'accept-language': 'en', 'x-client': 'web' },
      extracts: [],
    })
  })

  it('keeps the port in the host and falls back to the file name without servers', () => {
    expect(describeHost('x.yaml', doc({}, [
      { url: 'http://localhost:8080' },
    ]), []).host).toBe('localhost:8080')
    const warnings: string[] = []
    const host = describeHost('shop.example.com.yaml', doc({}, []), warnings)
    expect(host).toMatchObject({ host: 'shop.example.com', baseUrl: 'https://shop.example.com' })
    expect(warnings[0]).toMatch(/no servers entry/)
    const relative: string[] = []
    describeHost('shop.example.com.yaml', doc({}, [
      { url: '/api' },
    ]), relative)
    expect(relative[0]).toMatch(/is not absolute/)
  })

  it('drops a constant header with conflicting defaults, with a warning', () => {
    const warnings: string[] = []
    const host = describeHost('a.yaml', doc({
      '/a': {
        get: {
          operationId: 'a',
          parameters: [
            header('x-v', '1'),
          ],
        },
      },
      '/b': {
        get: {
          operationId: 'b',
          parameters: [
            header('x-v', '2'),
          ],
        },
      },
    }), warnings)
    expect(host.defaultHeaders).toEqual({})
    expect(warnings).toEqual(['specs/a.yaml: constant header x-v has different defaults across operations (1, 2); it is not sent by default'])
  })

  it('warns about operations without an id and parameters it cannot read', () => {
    const warnings: string[] = []
    describeHost('a.yaml', doc({
      '/a': {
        get: { responses: {} },
        put: {
          operationId: 'putA',
          parameters: [
            { $ref: '#/components/parameters/X' },
            { in: 'query' },
          ],
        },
      },
    }), warnings)
    expect(warnings).toEqual([
      'specs/a.yaml: GET /a has no operationId; its SDK function is named by hey-api and it gets no extract parser',
      'specs/a.yaml: PUT /a: parameter #/components/parameters/X is a reference; constant headers are only read from inline parameters',
      'specs/a.yaml: PUT /a: a parameter has no name or location and is ignored',
    ])
  })

  it('finds extraction specs on text responses only, from the lowest 2xx status', () => {
    const warnings: string[] = []
    const host = describeHost('a.yaml', doc({
      '/page': {
        get: {
          operationId: 'getPage',
          responses: {
            404: {
              content: {
                'text/html': { 'x-site-to-api-extract': HTML_EXTRACT },
              },
            },
            200: {
              content: {
                'text/html': {
                  'schema': { type: 'string' },
                  'x-site-to-api-extract': HTML_EXTRACT,
                },
              },
            },
          },
        },
      },
      '/json': {
        get: {
          operationId: 'getJson',
          responses: {
            200: {
              content: {
                'application/json': { 'x-site-to-api-extract': HTML_EXTRACT },
              },
            },
          },
        },
      },
      '/bad': {
        get: {
          operationId: 'getBad',
          responses: {
            200: {
              content: {
                'text/plain': {
                  'x-site-to-api-extract': { kind: 'csv' },
                },
              },
            },
          },
        },
      },
    }), warnings)
    expect(host.extracts).toEqual([
      {
        operationId: 'getPage',
        method: 'GET',
        path: '/page',
        status: '200',
        mimeType: 'text/html',
        spec: HTML_EXTRACT,
      },
    ])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/x-site-to-api-extract on application\/json is ignored/)
    expect(warnings[1]).toMatch(/GET \/bad: x-site-to-api-extract is not a valid extraction spec/)
  })
})

describe('describeHost security', () => {
  it('reads security schemes and the operations that declare security', () => {
    const document = OpenApiDocumentSchema.parse({
      openapi: '3.1.0',
      servers: [
        { url: 'https://api.example.com' },
      ],
      security: [
        { bearer: [] },
      ],
      components: {
        securitySchemes: {
          key: { type: 'apiKey', in: 'header', name: 'Authorization' },
          bearer: { type: 'http', scheme: 'Bearer' },
          broken: { in: 'header' },
        },
      },
      paths: {
        '/a': {
          get: {
            operationId: 'getA',
            security: [
              { key: [] },
            ],
          },
        },
        '/b': {
          get: { operationId: 'getB' },
        },
        '/public': {
          get: { operationId: 'getPublic', security: [] },
        },
        '/optional': {
          get: {
            operationId: 'getOptional',
            security: [{}],
          },
        },
      },
    })
    const warnings: string[] = []
    const host = describeHost('api.example.com.yaml', document, warnings)
    expect(host.auth).toEqual([
      {
        name: 'bearer',
        type: 'http',
        in: null,
        parameter: null,
        scheme: 'bearer',
      },
      {
        name: 'key',
        type: 'apiKey',
        in: 'header',
        parameter: 'Authorization',
        scheme: null,
      },
    ])
    // `security: []` opts out, and `[{}]` means credentials are optional.
    expect(host.securedOperationIds).toEqual(['getA', 'getB'])
    expect(warnings).toEqual(['specs/api.example.com.yaml: security scheme broken has no type and is not described in the client README'])
  })

  it('has no auth for a spec without security', () => {
    const host = describeHost('a.yaml', doc({
      '/a': {
        get: { operationId: 'getA' },
      },
    }), [])
    expect(host.auth).toEqual([])
    expect(host.securedOperationIds).toEqual([])
  })
})

describe('describeHost probedRequires', () => {
  it('collects the requires lists of operations probe minimized, keeping empty ones', () => {
    const host = describeHost('a.yaml', doc({
      '/a': {
        get: {
          'operationId': 'getA',
          'x-site-to-api-requires': ['cookie:sid'],
        },
        post: { 'operationId': 'postA', 'x-site-to-api-requires': [] },
      },
      '/b': {
        get: { operationId: 'getB' },
      },
    }), [])
    expect(host.probedRequires).toEqual([
      ['cookie:sid'],
      [],
    ])
  })
})

describe('withoutBrowserOnlySteps', () => {
  const op = (operationId: string, kind: string): Record<string, unknown> => ({ operationId, 'x-site-to-api-kind': kind, 'responses': {} })

  it('drops bot-protection steps and path items left empty, keeping pages and calls', () => {
    const result = withoutBrowserOnlySteps(doc({
      '/': {
        get: op('getRoot', 'page'),
      },
      '/api/items': {
        get: op('getApiItems', 'api'),
        post: op('postApiItems', 'bot-protection'),
      },
      '/{a}/{b}/mfc': {
        get: op('getByAByBMfc', 'bot-protection'),
      },
    }))
    expect(result && describeHost('api.example.com.yaml', result, []).operationIds).toEqual(['getApiItems', 'getRoot'])
    expect(Object.keys(result?.paths ?? {})).toEqual(['/', '/api/items'])
  })

  it('returns null when only bot-protection steps are left', () => {
    expect(withoutBrowserOnlySteps(doc({
      '/inputs': {
        get: op('getInputs', 'bot-protection'),
      },
      '/mp_verify': {
        post: op('postMpVerify', 'bot-protection'),
      },
    }))).toBeNull()
  })
})

describe('openApiDocumentSchema', () => {
  it('rejects documents without an openapi version', () => {
    expect(OpenApiDocumentSchema.safeParse({ swagger: '2.0' }).success).toBe(false)
  })
})

describe('toIdentifier and toPascalCase', () => {
  it('make identifiers from hosts and operation ids', () => {
    expect(toIdentifier('Shop.Example.com:8080')).toBe('shop_example_com_8080')
    expect(toIdentifier('1.example')).toBe('_1_example')
    expect(toPascalCase('getApiItem')).toBe('GetApiItem')
    expect(toPascalCase('get-api_item.v2')).toBe('GetApiItemV2')
  })

  it('never returns a reserved word or a name client/index.ts declares', () => {
    expect(toIdentifier('default')).toBe('default_')
    expect(toIdentifier('new:443')).toBe('new_443')
    expect(toIdentifier('in')).toBe('in_')
    expect(toIdentifier('sdks')).toBe('sdks_')
    expect(toIdentifier('h`o$s{t}\'q"x.example')).toBe('h_o_s_t_q_x_example')
  })
})

describe('describeHost: GraphQL operations', () => {
  const graphql = {
    endpoint: '/graphql',
    operationName: 'StoreHours',
    operationType: 'query',
    operationTypeFrom: 'get',
    persistedQuery: {
      version: 1,
      sha256Hash: 'c'.repeat(64),
    },
    document: null,
    batched: false,
    sent: {
      body: [],
      query: ['extensions', 'operationName', 'variables'],
    },
  }

  it('reads x-site-to-api-graphql with where the variables go and the other query parameters', () => {
    const host = describeHost('api.example.com.yaml', doc({
      '/graphql#StoreHours': {
        get: {
          'operationId': 'storeHours',
          'parameters': [
            {
              name: 'operationName',
              in: 'query',
              required: true,
              schema: { const: 'StoreHours' },
            },
            {
              name: 'locale',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'string' },
            },
            {
              name: 'variables',
              in: 'query',
              required: true,
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          ],
          'responses': {},
          'x-site-to-api-graphql': graphql,
        },
      },
    }), [])
    expect(host.graphql).toEqual([
      {
        ...graphql,
        operationId: 'storeHours',
        method: 'GET',
        path: '/graphql#StoreHours',
        variablesIn: 'query',
        variablesRequired: true,
        otherQuery: [
          { name: 'locale', required: true },
          { name: 'page', required: false },
        ],
      },
    ])
  })

  it('warns about an unreadable extension and gives the operation no GraphQL function', () => {
    const warnings: string[] = []
    const host = describeHost('api.example.com.yaml', doc({
      '/graphql': {
        post: {
          'operationId': 'x',
          'responses': {},
          'x-site-to-api-graphql': { endpoint: 1 },
        },
      },
    }), warnings)
    expect(host.graphql).toEqual([])
    expect(warnings[0]).toMatch(/x-site-to-api-graphql could not be read/)
  })
})
