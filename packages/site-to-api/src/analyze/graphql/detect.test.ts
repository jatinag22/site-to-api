import { describe, expect, it } from 'vitest'
import { fakeHash, graphqlGet, graphqlPost } from '../../../test/graphql'
import { exchange, jsonBody } from '../../../test/helpers'
import { detectGraphqlRequests } from './detect'

const HASH = fakeHash('1f')

describe('detectGraphqlRequests: JSON bodies', () => {
  it('reads a persisted query sent with POST', () => {
    const [request] = detectGraphqlRequests(graphqlPost({
      operationName: 'queryArtistOverview',
      variables: { uri: 'x' },
      hash: HASH,
    })) ?? []
    expect(request).toEqual({
      operationName: 'queryArtistOverview',
      document: null,
      operationType: 'unknown',
      persistedQuery: { version: 1, sha256Hash: HASH },
      key: 'queryArtistOverview',
      transport: 'body',
      sent: {
        body: ['extensions', 'operationName', 'variables'],
        query: [],
      },
      pathNamesOperation: false,
      batchIndex: null,
    })
  })

  it('reads the type and name from a query document', () => {
    const [mutation] = detectGraphqlRequests(graphqlPost({
      query: 'mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }',
      variables: { id: '1' },
    })) ?? []
    expect(mutation).toMatchObject({ operationName: 'AddToCart', operationType: 'mutation', key: 'AddToCart' })
    const [named] = detectGraphqlRequests(graphqlPost({ operationName: 'B', query: 'query A { a } mutation B { b }' })) ?? []
    expect(named).toMatchObject({ operationName: 'B', operationType: 'mutation' })
  })

  it('keys anonymous documents by a hash of the normalised text, so layout does not matter', () => {
    const [a] = detectGraphqlRequests(graphqlPost({ query: '{ me { id } }' })) ?? []
    const [b] = detectGraphqlRequests(graphqlPost({ query: '{\n  me {\n    id\n  }\n}' })) ?? []
    expect(a?.operationType).toBe('query')
    expect(a?.key).toMatch(/^document:[0-9a-f]{64}$/)
    expect(b?.key).toBe(a?.key)
    const [persisted] = detectGraphqlRequests(graphqlPost({ hash: HASH })) ?? []
    expect(persisted?.key).toBe(`sha256:${HASH}`)
  })

  it('splits a batched array body into one request per element', () => {
    const batch = exchange({
      method: 'POST',
      url: 'https://api.example.test/graphql',
      requestBody: jsonBody([
        { operationName: 'A', variables: {}, query: 'query A { a }' },
        {
          operationName: 'B',
          variables: { x: 1 },
          query: 'mutation B { b }',
        },
      ]),
      responseBody: jsonBody([
        {
          data: { a: 1 },
        },
        {
          data: { b: 2 },
        },
      ]),
    })
    expect(detectGraphqlRequests(batch)?.map(request => [request.operationName, request.operationType, request.batchIndex])).toEqual([
      ['A', 'query', 0],
      ['B', 'mutation', 1],
    ])
  })

  it('ignores JSON that only looks similar: a search `query`, a lone operationName, a mixed batch', () => {
    const search = exchange({
      method: 'POST',
      url: 'https://shop.test/search',
      requestBody: jsonBody({ query: 'red shoes', page: 1 }),
    })
    expect(detectGraphqlRequests(search)).toBeNull()
    const lone = exchange({
      method: 'POST',
      url: 'https://shop.test/track',
      requestBody: jsonBody({ operationName: 'checkout' }),
    })
    expect(detectGraphqlRequests(lone)).toBeNull()
    const mixed = exchange({
      method: 'POST',
      url: 'https://shop.test/x',
      requestBody: jsonBody([
        { query: '{ a }' },
        { id: 1 },
      ]),
    })
    expect(detectGraphqlRequests(mixed)).toBeNull()
    const shortHash = exchange({
      method: 'POST',
      url: 'https://shop.test/x',
      requestBody: jsonBody({
        extensions: {
          persistedQuery: { sha256Hash: 'abc' },
        },
      }),
    })
    expect(detectGraphqlRequests(shortHash)).toBeNull()
    expect(detectGraphqlRequests(exchange({ url: 'https://shop.test/api/items' }))).toBeNull()
  })

  it('does not take a JSON object in a `query` field for an anonymous query', () => {
    const bulk = exchange({
      method: 'POST',
      url: 'https://shop.test/api/bulk',
      requestBody: jsonBody({ query: '{"status":"old"}', action: 'archive' }),
    })
    expect(detectGraphqlRequests(bulk)).toBeNull()
    const search = exchange({ url: `https://shop.test/items?query=${encodeURIComponent('{"name":"x"}')}` })
    expect(detectGraphqlRequests(search)).toBeNull()
  })

  it('treats an operationName that is not a GraphQL name as no name', () => {
    const [request] = detectGraphqlRequests(graphqlPost({ operationName: 'a?debug=1', variables: {}, hash: HASH })) ?? []
    expect(request).toMatchObject({ operationName: null, key: `sha256:${HASH}` })
    const [braces] = detectGraphqlRequests(graphqlPost({ operationName: '{x}', query: 'query Real { a }' })) ?? []
    // The document still names its only operation.
    expect(braces?.operationName).toBe('Real')
    expect(detectGraphqlRequests(graphqlPost({ operationName: 'a b', variables: {} }))).toBeNull()
  })
})

describe('detectGraphqlRequests: query strings and paths', () => {
  it('reads GET requests with JSON variables and extensions', () => {
    const [request] = detectGraphqlRequests(graphqlGet({
      operationName: 'StoreHours',
      variables: { slug: 'x' },
      hash: HASH,
      extraQuery: { locale: 'en' },
    })) ?? []
    expect(request).toMatchObject({
      operationName: 'StoreHours',
      transport: 'query',
      persistedQuery: { version: 1, sha256Hash: HASH },
      sent: {
        body: [],
        query: ['extensions', 'operationName', 'variables'],
      },
      pathNamesOperation: false,
    })
  })

  it('reads a GET query document', () => {
    const [request] = detectGraphqlRequests(exchange({ url: `https://api.example.test/graphql?query=${encodeURIComponent('{ me { id } }')}` })) ?? []
    expect(request).toMatchObject({
      operationType: 'query',
      transport: 'query',
      sent: {
        query: ['query'],
      },
    })
  })

  it('recognises /<Name>/<sha256> paths and takes the hash from them', () => {
    const [request] = detectGraphqlRequests(graphqlPost({
      path: `/api/v3/StaysPdpSections/${HASH}`,
      operationName: 'StaysPdpSections',
      variables: { id: '1' },
    })) ?? []
    expect(request).toMatchObject({
      pathNamesOperation: true,
      persistedQuery: { version: null, sha256Hash: HASH },
    })
    // A different name in the body: the path does not name this operation.
    const [other] = detectGraphqlRequests(graphqlPost({ path: `/api/v3/Other/${HASH}`, operationName: 'StaysPdpSections', variables: {} })) ?? []
    expect(other?.pathNamesOperation).toBe(false)
  })

  it('accepts the path form alone only with a GraphQL field in the request or GraphQL errors', () => {
    const answered = exchange({
      url: `https://api.example.test/api/v3/Header/${HASH}?operationName=Header&locale=en`,
      responseBody: jsonBody({
        data: { header: {} },
      }),
    })
    expect(detectGraphqlRequests(answered)?.[0]).toMatchObject({ operationName: 'Header', pathNamesOperation: true, transport: 'query' })
    const failed = exchange({
      url: `https://api.example.test/api/v3/Header/${HASH}`,
      responseBody: jsonBody({
        errors: [
          { message: 'PersistedQueryNotFound' },
        ],
      }),
    })
    expect(detectGraphqlRequests(failed)?.[0]?.operationName).toBe('Header')
    const file = exchange({
      url: `https://cdn.example.test/assets/Bundle/${HASH}`,
      responseBody: jsonBody({ ok: true }),
    })
    expect(detectGraphqlRequests(file)).toBeNull()
  })

  it('keeps REST endpoints with a hash id and a `data` envelope out', () => {
    const rest = exchange({
      url: `https://api.example.test/api/tx/${HASH}`,
      responseBody: jsonBody({
        data: { amount: 10 },
      }),
    })
    expect(detectGraphqlRequests(rest)).toBeNull()
    const named = exchange({
      url: `https://api.example.test/api/Transaction/${HASH}`,
      responseBody: jsonBody({
        data: { amount: 10 },
      }),
    })
    expect(detectGraphqlRequests(named)).toBeNull()
    const extra = exchange({
      url: `https://api.example.test/api/Transaction/${HASH}?operationName=Transaction`,
      responseBody: jsonBody({
        data: {},
        meta: { page: 1 },
      }),
    })
    expect(detectGraphqlRequests(extra)).toBeNull()
    const loose = exchange({
      url: `https://api.example.test/api/Transaction/${HASH}`,
      responseBody: jsonBody({
        errors: ['not found'],
      }),
    })
    expect(detectGraphqlRequests(loose)).toBeNull()
  })
})
