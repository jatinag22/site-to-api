import type { Exchange, Operation, SourceRoute } from '../../model'
import { describe, expect, it } from 'vitest'
import { fakeHash, graphqlGet, graphqlPost } from '../../../test/graphql'
import { exchange, jsonBody, textBody } from '../../../test/helpers'
import { annotateGraphql } from '../graphql'
import { isIdentifierLike, isStrongIdentifier } from './identifiers'
import { operationIdFor, singular } from './naming'
import { buildOperations } from './operations'

function get(path: string, init: Partial<Parameters<typeof exchange>[0]> = {}): Exchange {
  return exchange({ url: `https://shop.test${path}`, ...init })
}

function route(pathTemplate: string, init: Partial<SourceRoute> = {}): SourceRoute {
  const params = [
    ...pathTemplate.matchAll(/\{(\w+)\}/g),
  ].map(match => match[1]!)
  return {
    method: null,
    host: null,
    pathTemplate,
    params,
    ref: {
      file: 'src/api.ts',
      line: 1,
      column: 1,
      functionName: null,
      original: true,
      excerpt: null,
    },
    ...init,
  }
}

function paths(operations: Operation[]): string[] {
  return operations.map(operation => `${operation.method} ${operation.path}`)
}

const build = (exchanges: Exchange[], sourceRoutes: SourceRoute[] = []): Operation[] => buildOperations(exchanges, { sourceRoutes })

describe('buildOperations: path parameters', () => {
  it('turns varying identifier segments into named parameters', () => {
    const operations = build([
      get('/api/products/12'),
      get('/api/products/13'),
      get('/api/products/14/reviews'),
    ])
    expect(paths(operations)).toEqual(['GET /api/products/{productId}', 'GET /api/products/14/reviews'])
    const [product] = operations
    expect(product!.pathParams).toEqual([
      {
        name: 'productId',
        index: 2,
        schema: { type: 'integer' },
        evidence: ['varies', 'looks-like-id'],
      },
    ])
    expect(product!.exchanges).toHaveLength(2)
    expect(product!.operationId).toBe('getApiProductsByProductId')
  })

  it('does not turn different plain words into a parameter', () => {
    expect(paths(build([
      get('/api/marketStatus'),
      get('/api/disclaimer'),
    ]))).toEqual(['GET /api/disclaimer', 'GET /api/marketStatus'])
  })

  it('keeps words literal next to identifiers in the same position', () => {
    expect(paths(build([
      get('/api/products/12'),
      get('/api/products/34'),
      get('/api/products/search'),
    ])))
      .toEqual(['GET /api/products/{productId}', 'GET /api/products/search'])
  })

  it('treats strong identifiers as parameters on sight', () => {
    const operations = build([
      get('/api/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    ])
    expect(paths(operations)).toEqual(['GET /api/orders/{orderId}'])
    expect(operations[0]!.pathParams[0]!.evidence).toEqual(['looks-like-id'])
    expect(operations[0]!.pathParams[0]!.schema).toEqual({ type: 'string', format: 'uuid' })
  })

  it('handles UPPER_CASE symbols, slugs and several parameters', () => {
    expect(paths(build([
      get('/api/ipo/RELIANCE/bids'),
      get('/api/ipo/TCS/bids'),
    ]))).toEqual(['GET /api/ipo/{ipoId}/bids'])
    const slugs = build([
      get('/p/iphone-15-pro'),
      get('/p/galaxy-s24'),
    ])
    expect(slugs[0]!.path).toBe('/p/{slug}')
    const nested = build([
      get('/users/12/orders/98'),
      get('/users/13/orders/99'),
    ])
    expect(nested[0]!.path).toBe('/users/{userId}/orders/{orderId}')
    expect(nested[0]!.operationId).toBe('getUsersByUserIdOrdersByOrderId')
    expect(build([
      get('/12/34'),
      get('/56/78'),
    ])[0]!.path).toBe('/{param1}/{param2}')
  })

  it('lets a matching source route win and name the parameter', () => {
    const operations = build([
      get('/api/ipo/RELIANCE'),
    ], [
      route('/api/ipo/{symbol}'),
    ])
    expect(paths(operations)).toEqual(['GET /api/ipo/{symbol}'])
    expect(operations[0]!.pathParams[0]).toMatchObject({
      name: 'symbol',
      evidence: ['source-template'],
    })
  })

  it('shares parameter names across methods on the same path', () => {
    const operations = build([
      get('/api/items/12'),
      get('/api/items/13'),
      get('/api/items/12', { method: 'DELETE' }),
      get('/api/items/14', { method: 'DELETE' }),
    ])
    expect(paths(operations)).toEqual(['DELETE /api/items/{itemId}', 'GET /api/items/{itemId}'])
  })
})

describe('buildOperations: grouping, ids and summaries', () => {
  it('only uses api, page and bot-protection exchanges', () => {
    const operations = build([
      get('/', {
        kind: 'page',
        resourceType: 'document',
        responseBody: textBody('<html>'),
      }),
      get('/logo.png', { kind: 'asset' }),
      get('/collect', { kind: 'noise' }),
      {
        ...get('/sensor', { kind: 'bot-protection', method: 'POST' }),
        kindReason: 'Akamai: request body matches sensor_data',
      },
    ])
    expect(operations.map(operation => [operation.operationId, operation.kind, operation.summary])).toEqual([
      ['getRoot', 'page', 'Page home.'],
      ['postSensor', 'bot-protection', 'Bot protection (Akamai), browser only.'],
    ])
  })

  it('separates hosts and makes colliding ids unique deterministically', () => {
    const operations = build([
      get('/api/items-list'),
      get('/api/itemsList'),
      exchange({ url: 'https://other.test/api/items-list' }),
    ])
    expect(operations.map(operation => `${operation.host} ${operation.operationId}`)).toEqual([
      'other.test getApiItemsList',
      'shop.test getApiItemsList',
      'shop.test getApiItemsList2',
    ])
  })

  it('summarises from path words and response fields', () => {
    const [one] = build([
      get('/api/ipo/detail', {
        responseBody: jsonBody({ symbol: 'A', price: 1 }),
      }),
    ])
    expect(one!.summary).toBe('Get api ipo detail. Returns symbol, price.')
    const [list] = build([
      get('/api/items', {
        responseBody: jsonBody([
          { id: 1, name: 'x' },
        ]),
      }),
    ])
    expect(list!.summary).toBe('Get api items. Returns a list of id, name.')
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`f${index}`, index]))
    expect(build([
      get('/a', {
        responseBody: jsonBody(many),
      }),
    ])[0]!.summary).toBe('Get a. Returns f0, f1, f2, f3, f4, f5, f6, f7, +2 more.')
  })

  it('adds source-only operations for routes never observed', () => {
    const operations = build(
      [
        get('/', { kind: 'page', resourceType: 'document' }),
        get('/api/ipo/RELIANCE'),
      ],
      [
        route('/api/ipo/{symbol}'),
        route('/api/ipo/{symbol}/bids', { method: 'POST' }),
        route('/v1/x', { host: 'api.shop.test' }),
      ],
    )
    const sourceOnly = operations.filter(operation => operation.sourceOnly)
    expect(sourceOnly.map(operation => `${operation.host} ${operation.method} ${operation.path} ${operation.operationId}`)).toEqual([
      'api.shop.test GET /v1/x getV1X',
      'shop.test POST /api/ipo/{symbol}/bids postApiIpoBySymbolBids',
    ])
    expect(sourceOnly[1]!.pathParams).toEqual([
      {
        name: 'symbol',
        index: 2,
        schema: { type: 'string' },
        evidence: ['source-template'],
      },
    ])
    expect(sourceOnly[1]!.summary).toBe('Post api ipo by symbol bids. Found in source code; not called during capture.')
    expect(operations.every(operation => operation.sentFrom.length === 0)).toBe(true)
    expect(sourceOnly.map(operation => operation.methodUnknown)).toEqual([true, undefined])
  })

  it('marks a source-only route without a method as method unknown instead of presenting a guess', () => {
    const operations = build(
      [
        get('/', { kind: 'page', resourceType: 'document' }),
      ],
      [
        route('/api/auth/login'),
        route('/api/cart', { method: 'POST' }),
        route('/api/cart'),
      ],
    )
    const login = operations.find(operation => operation.path === '/api/auth/login')
    expect(login).toMatchObject({ method: 'GET', sourceOnly: true, methodUnknown: true })
    expect(login?.summary).toBe('Api auth login (method unknown). Found in source code; not called during capture.')
    // The route with a known method wins the shared slot, whatever order the code listed them in.
    expect(operations.filter(operation => operation.path === '/api/cart').map(operation => [operation.method, operation.methodUnknown])).toEqual([
      ['POST', undefined],
    ])
  })

  it('is deterministic regardless of input order', () => {
    const list = [
      get('/api/b/12'),
      get('/api/a'),
      get('/api/b/13'),
    ]
    expect(paths(build(list))).toEqual(paths(build([...list].reverse())))
  })
})

describe('identifiers and naming', () => {
  it.each([
    ['123', true],
    ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', true],
    ['a1b2c3d4', true],
    ['3mJr7AoUXx2Wqd', true],
    ['RELIANCE', true],
    ['NIFTY_50', true],
    ['iphone-15', true],
    ['marketStatus', false],
    ['disclaimer', false],
    ['v1', false],
    ['blue-shoes', false],
    ['', false],
  ])('isIdentifierLike(%s) is %s', (segment, expected) => {
    expect(isIdentifierLike(segment)).toBe(expected)
  })

  it('strong identifiers need length', () => {
    expect(isStrongIdentifier('2024')).toBe(false)
    expect(isStrongIdentifier('123456')).toBe(true)
    expect(isStrongIdentifier('deadbeefdeadbeef00')).toBe(true)
    expect(isStrongIdentifier('notificationsettings')).toBe(false)
  })

  it('singularises and builds ids', () => {
    expect([
      'products',
      'categories',
      'addresses',
      'boxes',
      'status',
      'bids',
    ].map(singular))
      .toEqual([
        'product',
        'category',
        'address',
        'box',
        'status',
        'bid',
      ])
    expect(operationIdFor('GET', '/api/v1/items.json')).toBe('getApiV1ItemsJson')
    expect(operationIdFor('POST', '/')).toBe('postRoot')
  })
})

describe('buildOperations: slugs', () => {
  const page = (body: string): Parameters<typeof get>[1] => ({
    kind: 'page',
    responseBody: textBody(body),
  })
  const storePage = (name: string): Parameters<typeof get>[1] => page(`<main class="store"><h1>${name}</h1><dl class="facts"><dt>Hours</dt><dd>9-5</dd></dl></main>`)

  it('makes linked slugs a parameter when a listing links to several pages built from one template', () => {
    const listing = get('/stores', page('<a href="/stores/pine-hill">Pine</a><a href="/stores/cedar-park">Cedar</a><a href="/stores/maple-cross">Maple</a>'))
    const operations = build([
      listing,
      get('/stores/pine-hill', storePage('Pine Hill')),
      get('/stores/cedar-park', storePage('Cedar Park')),
      get('/stores/maple-cross', storePage('Maple Cross')),
    ])
    expect(paths(operations)).toEqual(['GET /stores', 'GET /stores/{slug}'])
    expect(operations.find(op => op.path === '/stores/{slug}')?.pathParams[0]?.evidence).toEqual(['value-trace', 'varies'])
  })

  it('keeps root pages from a navigation menu separate', () => {
    const home = get('/', page('<nav><a href="/about-us">About</a><a href="/contact-us">Contact</a><a href="/privacy-policy">Privacy</a></nav>'))
    const operations = build([
      home,
      get('/about-us', page('<p>about</p>')),
      get('/contact-us', page('<form></form>')),
      get('/privacy-policy', page('<p>p</p>')),
    ])
    expect(paths(operations)).toEqual([
      'GET /',
      'GET /about-us',
      'GET /contact-us',
      'GET /privacy-policy',
    ])
  })

  it('ignores endpoint names that only appear inside page scripts', () => {
    const shell = get('/', page('<script>fetch("/api/all-upcoming-issues");fetch("/api/past-issues-list");fetch("/api/live-ofs-active")</script>'))
    const operations = build([
      shell,
      get('/api/all-upcoming-issues'),
      get('/api/past-issues-list'),
      get('/api/live-ofs-active'),
    ])
    expect(paths(operations)).toContain('GET /api/all-upcoming-issues')
    expect(paths(operations)).not.toContain('GET /api/{slug}')
  })

  it('needs pages that share a structure, not just links', () => {
    const listing = get('/help', page('<a href="/help/getting-started">a</a><a href="/help/billing-faq">b</a><a href="/help/contact-form">c</a>'))
    const operations = build([
      listing,
      get('/help/getting-started', page('<article><h1>x</h1><ol><li>1</li></ol><video></video></article>')),
      get('/help/billing-faq', page('<section class="faq"><details><summary>q</summary></details></section>')),
      get('/help/contact-form', page('<form class="contact"><input><textarea></textarea><button></button></form>')),
    ])
    expect(paths(operations)).not.toContain('GET /help/{slug}')
  })

  it('matches whole paths, not prefixes', () => {
    const listing = get('/stores', page('<a href="/stores/pine-hills">P</a><a href="/stores/cedar-parks">C</a><a href="/stores/maple-crosses">M</a>'))
    const operations = build([
      listing,
      get('/stores/pine-hill', storePage('a')),
      get('/stores/cedar-park', storePage('b')),
      get('/stores/maple-cross', storePage('c')),
    ])
    expect(paths(operations)).not.toContain('GET /stores/{slug}')
  })
})

describe('buildOperations: sibling paths (decision 0031)', () => {
  const article = (title: string): Parameters<typeof get>[1] => ({
    kind: 'page',
    responseBody: textBody(`<header class="top"><nav class="menu"></nav></header><main class="article"><h1 class="title">${title}</h1><p class="lead">x</p></main><footer class="foot"></footer>`),
  })
  const summary = (title: string): Parameters<typeof get>[1] => ({
    responseBody: jsonBody({
      title,
      extract: 'text',
      thumbnail: { source: 'x', width: 1 },
    }),
  })

  it('templates titles when many distinct values share one response structure', () => {
    const operations = build([
      'Cipher',
      'Lord_Byron',
      'Machine',
      'Finite_set',
      'Writer',
    ].map(title => get(`/api/rest_v1/page/summary/${title}`, summary(title))))
    expect(paths(operations)).toEqual(['GET /api/rest_v1/page/summary/{title}'])
    expect(operations[0]!.pathParams[0]!.evidence).toEqual(['varies'])
  })

  it('templates tags that a listing links to, even when only two were opened', () => {
    const listing = get('/questions', article('<a href="/questions/tagged/python">p</a><a href="/questions/tagged/javascript">j</a><a href="/questions/tagged/rust">r</a>'))
    const operations = build([
      listing,
      get('/questions/tagged/python', article('python')),
      get('/questions/tagged/javascript', article('javascript')),
    ])
    expect(paths(operations)).toEqual(['GET /questions', 'GET /questions/tagged/{tag}'])
  })

  it('templates the slug after an id', () => {
    const listing = get('/questions', article('<a href="/questions/80013191/how-do-i-fly">a</a><a href="/questions/80013112/why-is-pyright-angry">b</a><a href="/questions/80013188/how-can-i-unregister">c</a>'))
    expect(paths(build([
      listing,
      get('/questions/80013191/how-do-i-fly', article('a')),
      get('/questions/80013112/why-is-pyright-angry', article('b')),
    ]))).toEqual(['GET /questions', 'GET /questions/{questionId}/{slug}'])
  })

  it('templates an owner/repo pair that recurs under several paths, one repo per session', () => {
    const repo = (owner: string, name: string, sessionId: string): Exchange[] => [
      get(`/${owner}/${name}/latest-commit`, {
        sessionId,
        responseBody: jsonBody({
          oid: 'a',
          author: { login: 'x' },
        }),
      }),
      get(`/${owner}/${name}/refs`, {
        sessionId,
        responseBody: jsonBody({
          refs: ['main'],
          cacheKey: 'k',
        }),
      }),
      get(`/${owner}/${name}/issues/1/timeline`, {
        sessionId,
        responseBody: jsonBody({ items: [] }),
      }),
      get(`/${owner}/${name}/_file_tree`, {
        sessionId,
        method: 'POST',
        responseBody: jsonBody({ tree: [] }),
      }),
    ]
    const operations = build([
      ...repo('expressjs', 'express', 's1'),
      ...repo('koajs', 'koa', 's2').slice(0, 2),
    ], [
      route('/{owner}/{repo}/_file_tree', { method: 'POST' }),
    ])
    expect(paths(operations)).toEqual([
      'POST /{owner}/{repo}/_file_tree',
      'GET /{owner}/{repo}/issues/1/timeline',
      'GET /{owner}/{repo}/latest-commit',
      'GET /{owner}/{repo}/refs',
    ])
  })

  it('keeps `/api/users/me` apart from `/api/users/123`, even across sessions', () => {
    const user = jsonBody({ id: 123, name: 'Ann' })
    expect(paths(build([
      get('/api/users/me', { sessionId: 's1', responseBody: user }),
      get('/api/users/123', { sessionId: 's2', responseBody: user }),
    ]))).toEqual(['GET /api/users/123', 'GET /api/users/me'])
  })

  it('keeps different endpoints apart when their responses differ', () => {
    expect(paths(build([
      get('/api/v1/users', {
        sessionId: 's1',
        responseBody: jsonBody({
          users: [
            { id: 1, email: 'a' },
          ],
        }),
      }),
      get('/api/v1/orders', {
        sessionId: 's2',
        responseBody: jsonBody({
          orders: [
            { id: 1, total: 2 },
          ],
        }),
      }),
      get('/api/v1/stats', {
        sessionId: 's3',
        responseBody: jsonBody({ visits: 1 }),
      }),
    ]))).toEqual(['GET /api/v1/orders', 'GET /api/v1/stats', 'GET /api/v1/users'])
  })

  it('templates docs pages under a section and keeps the section names literal', () => {
    const sidebar = '<a href="/docs/app/getting-started/caching">c</a><a href="/docs/app/getting-started/css">s</a><a href="/docs/app/getting-started/fonts">f</a><a href="/docs/app/guides">g</a><a href="/docs/app/api-reference">a</a>'
    const operations = build([
      get('/docs/app/getting-started', article(sidebar)),
      get('/docs/app/guides', article(sidebar)),
      get('/docs/app/api-reference', article(sidebar)),
      get('/docs/app/getting-started/caching', article('caching')),
      get('/docs/app/getting-started/css', article('css')),
      get('/docs/app/guides/server-boundary', article('b')),
      get('/docs/app/api-reference/cli/create-app', article('cli')),
    ])
    expect(paths(operations)).toEqual([
      'GET /docs/app/api-reference',
      'GET /docs/app/api-reference/cli/create-app',
      'GET /docs/app/getting-started',
      'GET /docs/app/getting-started/{slug}',
      'GET /docs/app/guides',
      'GET /docs/app/guides/server-boundary',
    ])
  })

  it('templates a value that each session chose differently, and decodes it once', () => {
    const page = (sessionId: string): Parameters<typeof get>[1] => ({
      sessionId,
      ...article('results'),
    })
    const operations = build([
      get('/s/Lisbon--Portugal/homes', page('s1')),
      get('/s/Porto--Portugal/homes', page('s2')),
      get('/search/radiohead', page('s1')),
      get('/search/daft%20punk', page('s2')),
    ])
    expect(paths(operations)).toEqual(['GET /s/{query}/homes', 'GET /search/{query}'])
    const search = operations.find(operation => operation.path === '/search/{query}')
    expect(search!.exchanges.map(item => item.request.path)).toContain('/search/daft%20punk')
    expect(JSON.stringify(search!.pathParams[0]!.schema)).not.toContain('%25')
  })

  it('keeps two different words in one session literal', () => {
    expect(paths(build([
      get('/help/contact', article('a')),
      get('/help/shipping', article('b')),
    ]))).toEqual(['GET /help/contact', 'GET /help/shipping'])
  })
})

describe('buildOperations: GraphQL (decision 0027)', () => {
  const HASH_A = fakeHash('a1')
  const HASH_B = fakeHash('b2')

  it('gives every operation on a shared endpoint its own operation, id and spec path', () => {
    const operations = build(annotateGraphql([
      graphqlPost({
        path: '/pathfinder/v2/query',
        operationName: 'queryArtistOverview',
        variables: { uri: 'a' },
        hash: HASH_A,
        data: { artistUnion: {} },
      }),
      graphqlPost({
        path: '/pathfinder/v2/query',
        operationName: 'queryArtistOverview',
        variables: { uri: 'b' },
        hash: HASH_A,
        sessionId: 's2',
      }),
      graphqlPost({
        path: '/pathfinder/v2/query',
        operationName: 'searchDesktop',
        variables: { searchTerm: 'x', limit: 10 },
        hash: HASH_B,
      }),
      exchange({ url: 'https://api.example.test/api/items' }),
    ]))
    expect(operations.map(operation => [operation.operationId, operation.method, operation.path])).toEqual([
      ['getApiItems', 'GET', '/api/items'],
      ['queryArtistOverview', 'POST', '/pathfinder/v2/query#queryArtistOverview'],
      ['searchDesktop', 'POST', '/pathfinder/v2/query#searchDesktop'],
    ])
    const artist = operations.find(operation => operation.operationId === 'queryArtistOverview')
    expect(artist?.exchanges).toHaveLength(2)
    expect(artist?.graphql).toEqual({
      endpoint: '/pathfinder/v2/query',
      operationName: 'queryArtistOverview',
      operationType: 'unknown',
      operationTypeFrom: null,
      persistedQuery: { version: 1, sha256Hash: HASH_A },
      hashes: [HASH_A],
      document: null,
      batched: false,
      sent: {
        body: ['extensions', 'operationName', 'variables'],
        query: [],
      },
    })
    expect(artist?.summary).toBe('GraphQL operation queryArtistOverview (POST /pathfinder/v2/query). Returns artistUnion.')
  })

  it('keeps the literal path when it names the operation, and never makes the hash a parameter', () => {
    const operations = build(annotateGraphql([
      graphqlGet({
        path: `/api/v3/Header/${HASH_A}`,
        operationName: 'Header',
        variables: { a: 1 },
        hash: HASH_A,
      }),
      graphqlGet({
        path: `/api/v3/PdpCalendar/${HASH_B}`,
        operationName: 'PdpCalendar',
        variables: { id: '1' },
        hash: HASH_B,
      }),
      graphqlGet({
        path: `/api/v3/PdpCalendar/${HASH_B}`,
        operationName: 'PdpCalendar',
        variables: { id: '2' },
        hash: HASH_B,
        sessionId: 's2',
      }),
    ]))
    expect(operations.map(operation => [operation.operationId, operation.path, operation.pathParams.length])).toEqual([
      ['header', `/api/v3/Header/${HASH_A}`, 0],
      ['pdpCalendar', `/api/v3/PdpCalendar/${HASH_B}`, 0],
    ])
    expect(operations[0]?.graphql).toMatchObject({ operationType: 'query', operationTypeFrom: 'get' })
  })

  it('groups a redeployed operation (new hash in the path) and keeps the latest hash', () => {
    const operations = build(annotateGraphql([
      graphqlGet({
        path: `/api/v3/Header/${HASH_A}`,
        operationName: 'Header',
        variables: {},
        hash: HASH_A,
      }),
      graphqlGet({
        path: `/api/v3/Header/${HASH_B}`,
        operationName: 'Header',
        variables: {},
        hash: HASH_B,
        sessionId: 's2',
      }),
    ]))
    expect(operations).toHaveLength(1)
    expect(operations[0]?.path).toBe(`/api/v3/Header/${HASH_B}`)
    expect(operations[0]?.graphql?.hashes).toEqual([HASH_A, HASH_B].sort())
    expect(operations[0]?.graphql?.persistedQuery?.sha256Hash).toBe(HASH_B)
  })

  it('names operations without a name after their hash or document', () => {
    const operations = build(annotateGraphql([
      graphqlPost({ hash: HASH_A }),
      graphqlPost({ query: '{ me { id } }' }),
    ]))
    expect(operations.map(operation => operation.operationId)).toEqual([
      expect.stringMatching(/^graphqlDocument[0-9A-Za-z]{12}$/),
      'graphqlPersistedA1a1a1a1a1a1',
    ])
    expect(operations.every(operation => operation.path.startsWith('/graphql#'))).toBe(true)
  })

  it('reads the type from a document and matches source routes against the endpoint', () => {
    const operations = build(annotateGraphql([
      graphqlPost({
        query: 'mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }',
        variables: { id: '1' },
      }),
    ]), [
      route('/graphql', { method: 'POST' }),
    ])
    expect(operations.map(operation => [operation.operationId, operation.graphql?.operationType, operation.sourceOnly])).toEqual([
      ['addToCart', 'mutation', false],
    ])
  })
})
