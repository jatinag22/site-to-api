import type { SourceRoute } from '../../model'
import { describe, expect, it } from 'vitest'
import { screenSourceRoutes } from './screen'

function route(host: string | null, pathTemplate: string): SourceRoute {
  return {
    method: null,
    host,
    pathTemplate,
    params: [],
    ref: {
      file: 'src/api.ts',
      line: 1,
      column: 1,
      functionName: null,
      original: true,
      excerpt: null,
    },
  }
}

function kept(routes: SourceRoute[], observed: string[] = []): string[] {
  return screenSourceRoutes(routes, new Set(observed)).routes.map(item => `${item.host ?? ''}${item.pathTemplate}`)
}

describe('screenSourceRoutes', () => {
  it('drops hosts that are templates, fixtures or not public', () => {
    const junk = [
      'www.%suffixorigin%',
      'a@b',
      '@webgate',
      'x',
      'stub-host',
      'unknown',
      'тест',
      '$1.wikipedia.org',
      'localhost:4318',
      'localhost:8192',
      'api.shop.local',
      '10.0.0.1',
      'shop.test:abc',
      'www.example.com',
    ]
    expect(kept(junk.map(host => route(host, '/api/items')))).toEqual([])
  })

  it('keeps public hosts and any host the capture used', () => {
    expect(kept([
      route('api.shop-example.com', '/v1/items'),
      route('zzlz.gsxt.gov.cn', '/'),
      route('xn--80ak6aa92e.com', '/a'),
      route('cdn.shop.io:8443', '/b'),
      route('localhost:3000', '/api/items'),
    ], ['localhost:3000'])).toEqual([
      'api.shop-example.com/v1/items',
      'zzlz.gsxt.gov.cn/',
      'xn--80ak6aa92e.com/a',
      'cdn.shop.io:8443/b',
      'localhost:3000/api/items',
    ])
  })

  it('drops XML namespaces, file-system paths and unresolved placeholders', () => {
    expect(kept([
      route('www.w3.org', '/2000/svg'),
      route('www.w3.org', '/1999/xlink'),
      route(null, '/ROOT/node_modules/.pnpm/next@15.0.0/node_modules/next/dist/client/index.js'),
      route(null, '/Users/dev/app/src/api.ts'),
      route(null, '/privacy-experience/gvl/translations{param1}{toString}'),
      route(null, '/{str}.php'),
      route(null, '/{COPILOT_ASSIGNMENT_API_ENDPOINT}'),
      route(null, '/{url}'),
      route(null, '/search/%s'),
      route(null, '/w/$1'),
      route(null, '/{{base}}/items'),
    ])).toEqual([])
  })

  it('drops analytics and telemetry endpoints, as classify does for traffic', () => {
    expect(kept([
      route('app.datadoghq.com', '/rum/sessions'),
      route('intake-analytics.wikimedia.org', '/v1/events'),
      route('app.datadoghq.com', '/api/v1/dashboards'),
    ])).toEqual(['app.datadoghq.com/api/v1/dashboards'])
  })

  it('keeps real route templates', () => {
    expect(kept([
      route(null, '/api/products/{productId}'),
      route(null, '/api/items/{id}.json'),
      route(null, '/{locale}/products'),
      route(null, '/wiki/Caf%C3%A9'),
      route('www.w3.org', '/TR/'),
    ])).toEqual([
      '/api/products/{productId}',
      '/api/items/{id}.json',
      '/{locale}/products',
      '/wiki/Caf%C3%A9',
      'www.w3.org/TR/',
    ])
  })

  it('keeps the endpoint when the code glued a query placeholder to its last segment', () => {
    const result = screenSourceRoutes([
      {
        ...route(null, '/api/v2/autocompletes{query}'),
        params: ['query'],
      },
    ], new Set())
    expect(result.routes.map(item => [item.pathTemplate, item.params])).toEqual([
      ['/api/v2/autocompletes', []],
    ])
    expect(kept([
      route(null, '/suggestions/{subjectType}{subjectIdParam}'),
      route(null, '/bLayout-{o}.json'),
    ])).toEqual([])
  })

  it('counts what it dropped in one warning line with a few examples', () => {
    const result = screenSourceRoutes([
      route('a@b', '/x'),
      route('stub-host', '/y'),
      route('x', '/z'),
      route(null, '/{str}.php'),
      route('api.shop-example.com', '/ok'),
    ], new Set())
    expect(result.routes).toHaveLength(1)
    expect(result.warning).toBe('Ignored 4 endpoints found only in the site\'s code that cannot be real calls: "a@b/x" (not a hostname), "stub-host/y" (not a hostname), "x/z" (not a hostname), and 1 more.')
    expect(screenSourceRoutes([
      route(null, '/api/ok'),
    ], new Set()).warning).toBeNull()
  })
})
