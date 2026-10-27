import { afterAll, describe, expect, it } from 'vitest'
import { removeSessions, writeSession } from '../../../test/sessions'
import { findSourceEndpoints } from './endpoints'

afterAll(removeSessions)

const apiTs = `
import axios from 'axios'
import $ from 'jquery'

const API_BASE = 'https://api.shop.test/v2'

export async function loadProduct(product: { id: string }) {
  const res = await fetch(\`/api/products/\${product.id}\`)
  return res.json()
}

export function addToCart(item: { sku: string }, qty: number) {
  return fetch('/api/cart/items', { method: 'post', body: JSON.stringify({ sku: item.sku, qty }) })
}

export const listOrders = (userId: string) => axios.get('/api/users/' + userId + '/orders?page=1')

export function removeItem(cartId: string, itemId: string) {
  return axios({ url: \`/api/cart/\${cartId}/items/\${encodeURIComponent(itemId)}\`, method: 'DELETE' })
}

export function searchStores(q: string) {
  return axios.get(\`\${API_BASE}/stores/search?q=\${q}\`)
}

export function legacyReviews(id: string) {
  $.ajax({ url: '/Reviews/List.aspx?id=' + id, type: 'POST' })
  $.get('/legacy/stock.php')
}

export function ping() {
  const xhr = new XMLHttpRequest()
  xhr.open('PUT', '/api/ping')
  xhr.send()
}

export function trackUrl() {
  return new URL('/collect/v1/events', 'https://metrics.shop.test')
}

class Client {
  request(path: string) {
    return fetch(path)
  }

  profile() {
    return this.request('/me/profile')
  }
}

export const ROUTES = { orders: '/api/orders/{orderId}', home: '/home', logo: '/static/api/logo.png' }
export const unrelated = ['/about', 'rapid delivery', '/capital/plan']
export const client = new Client()
`

const bundleJs = 'function n(e){return fetch("/api/v1/stock/"+e.sku,{method:"GET"})}function r(t){var o=new XMLHttpRequest;o.open("POST","/rest/basket");return o}'

describe('findSourceEndpoints', () => {
  it('finds request call sites and API-like literals in original sources', async () => {
    const session = await writeSession('s1', [
      {
        url: 'https://shop.test/static/js/main.js',
        file: 'scripts/shop.test/static/js/main.js',
        content: '/* bundled */',
        sourceMap: {
          url: 'https://shop.test/static/js/main.js.map',
          file: 'sourcemaps/shop.test/static/js/main.js.map',
          map: { version: 3, sources: [], mappings: '' },
          sources: {
            'sources/shop.test/src/api.ts': apiTs,
            'sources/shop.test/node_modules/lib/index.js': 'fetch("/api/library-only")',
          },
        },
      },
    ])
    const routes = await findSourceEndpoints([session])
    const summary = routes.map(route => `${route.method ?? '-'} ${route.host ?? ''}${route.pathTemplate} [${route.params.join(',')}] ${route.ref.functionName ?? ''}`)
    expect(summary).toEqual([
      'POST /Reviews/List.aspx [] legacyReviews',
      'POST /api/cart/items [] addToCart',
      'DELETE /api/cart/{cartId}/items/{itemId} [cartId,itemId] removeItem',
      '- /api/orders/{orderId} [] ',
      'PUT /api/ping [] ping',
      'GET /api/products/{id} [id] loadProduct',
      'GET /api/users/{userId}/orders [userId] listOrders',
      'GET /legacy/stock.php [] legacyReviews',
      '- /me/profile [] profile',
      'GET api.shop.test/v2/stores/search [] searchStores',
      '- metrics.shop.test/collect/v1/events [] trackUrl',
    ])
    const product = routes.find(route => route.pathTemplate === '/api/products/{id}')
    expect(product?.ref).toEqual({
      file: 'src/api.ts',
      line: 8,
      column: 21,
      functionName: 'loadProduct',
      original: true,
      excerpt: null,
    })
  })

  it('parses bundles when no sourcemap was unpacked and deduplicates across sessions', async () => {
    const scripts = [
      { url: 'https://shop.test/app.min.js', file: 'scripts/shop.test/app.min.js', content: bundleJs },
    ]
    const first = await writeSession('s1', scripts)
    const second = await writeSession('s2', scripts)
    const routes = await findSourceEndpoints([first, second])
    expect(routes.map(route => [
      route.method,
      route.pathTemplate,
      route.params,
      route.ref.file,
      route.ref.original,
      route.ref.functionName,
    ])).toEqual([
      [
        'GET',
        '/api/v1/stock/{sku}',
        ['sku'],
        '/app.min.js',
        false,
        'n',
      ],
      [
        'POST',
        '/rest/basket',
        [],
        '/app.min.js',
        false,
        'r',
      ],
    ])
  })

  it('keeps an unknown method only when no call with a method used the same path', async () => {
    const session = await writeSession('s1', [
      {
        url: 'https://shop.test/a.js',
        file: 'scripts/a.js',
        content: 'const P = "/api/items"; function go(){ return fetch("/api/items", { method: "PATCH" }) } const Q = "/api/other"',
      },
    ])
    const routes = await findSourceEndpoints([session])
    expect(routes.map(route => `${route.method} ${route.pathTemplate}`)).toEqual(['PATCH /api/items', 'null /api/other'])
  })

  it('gives unnamed interpolations numbered names and leaves dynamic options without a method', async () => {
    const session = await writeSession('s1', [
      {
        url: 'https://shop.test/a.js',
        file: 'scripts/a.js',
        content: `function f(o){ return fetch(\`/api/a/\${o.x ? 1 : 2}/b/\${list[0]}\`, o) }`,
      },
    ])
    const routes = await findSourceEndpoints([session])
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      method: null,
      pathTemplate: '/api/a/{param1}/b/{param2}',
      params: ['param1', 'param2'],
    })
  })

  it('skips files that are not JavaScript or TypeScript and files missing on disk', async () => {
    const session = await writeSession('s1', [
      {
        url: 'https://shop.test/a.js',
        file: 'scripts/a.js',
        content: '',
        sourceMap: {
          url: 'https://shop.test/a.js.map',
          file: 'maps/a.js.map',
          map: {},
          sources: { 'sources/shop.test/src/App.vue': '<template>"/api/x"</template>' },
        },
      },
    ])
    session.meta.scripts.push({ url: 'https://shop.test/gone.js', file: 'scripts/gone.js', sourceMap: null })
    expect(await findSourceEndpoints([session])).toEqual([])
  })
})
