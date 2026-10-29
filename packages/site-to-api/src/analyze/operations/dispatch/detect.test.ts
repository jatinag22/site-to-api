import type { Exchange } from '../../../model'
import { describe, expect, it } from 'vitest'
import { exchange, formBody, jsonBody, textBody } from '../../../../test/helpers'
import { detectDispatcher } from './detect'

const QUOTE = 'https://www.example.test/api/NextApi/apiClient/GetQuoteApi'

function get(query: Record<string, string>, response: unknown, init: Partial<Parameters<typeof exchange>[0]> = {}): Exchange {
  return exchange({
    url: `${QUOTE}?${new URLSearchParams(query).toString()}`,
    responseBody: jsonBody(response),
    ...init,
  })
}

function summary(found: ReturnType<typeof detectDispatcher>): unknown {
  return found && {
    parameter: found.parameter,
    in: found.in,
    values: found.groups.map(group => [group.value, group.exchanges.length]),
  }
}

/** NSE's `GetQuoteApi`: `functionName` picks the function; each has its own parameters and shape. */
function nse(): Exchange[] {
  return [
    get({
      functionName: 'getSymbolData',
      marketType: 'N',
      series: 'EQ',
      symbol: 'RELIANCE',
    }, {
      equityResponse: [
        {
          orderBook: { buyPrice1: 1 },
          metaData: { symbol: 'RELIANCE' },
        },
      ],
    }),
    get({ functionName: 'getMetaData', symbol: 'RELIANCE' }, { symbol: 'RELIANCE', companyName: 'Reliance Industries', isin: 'INE002A01018' }),
    get({ functionName: 'getTopTenStock' }, {
      topGainers: [
        { symbol: 'A', pChange: 1 },
      ],
      topLoosers: [
        { symbol: 'B', pChange: -1 },
      ],
    }),
    get({ functionName: 'getTopTenStock' }, {
      topGainers: [
        { symbol: 'C', pChange: 2 },
      ],
      topLoosers: [
        { symbol: 'D', pChange: -2 },
      ],
    }),
    get({ functionName: 'getSymbolChartData', symbol: 'RELIANCE', days: '1D' }, {
      grapthData: [
        [1, 2],
      ],
      closePrice: 3,
    }),
  ]
}

describe('detectDispatcher', () => {
  it('finds NSE\'s functionName dispatcher, one group per value', () => {
    expect(summary(detectDispatcher(nse()))).toEqual({
      parameter: 'functionName',
      in: 'query',
      values: [
        ['getMetaData', 1],
        ['getSymbolChartData', 1],
        ['getSymbolData', 1],
        ['getTopTenStock', 2],
      ],
    })
  })

  it('finds a WordPress admin-ajax.php action sent as a form field', () => {
    const ajax = (fields: Record<string, string>, response: unknown): Exchange => exchange({
      method: 'POST',
      url: 'https://blog.example.test/wp-admin/admin-ajax.php',
      requestBody: formBody(fields),
      responseBody: jsonBody(response),
    })
    const found = detectDispatcher([
      ajax({ action: 'heartbeat', interval: '60', _nonce: 'abc' }, { 'wp-auth-check': true, 'server_time': 1 }),
      ajax({ action: 'load_more_posts', page: '2', category: 'news' }, {
        success: true,
        data: {
          posts: [
            { id: 1, title: 'x' },
          ],
        },
      }),
      ajax({ action: 'wc_get_cart' }, {
        cart: {
          items: [
            { key: 'k', quantity: 1 },
          ],
          total: '1.00',
        },
      }),
    ])
    expect(summary(found)).toEqual({
      parameter: 'action',
      in: 'form',
      values: [
        ['heartbeat', 1],
        ['load_more_posts', 1],
        ['wc_get_cart', 1],
      ],
    })
  })

  it('finds JSON-RPC methods, telling them apart by their params', () => {
    const rpc = (method: string, params: unknown, result: unknown, id: number): Exchange => exchange({
      method: 'POST',
      url: 'https://node.example.test/rpc',
      requestBody: jsonBody({ jsonrpc: '2.0', id, method, params }),
      responseBody: jsonBody({ jsonrpc: '2.0', id, result }),
    })
    const found = detectDispatcher([
      rpc('eth_blockNumber', [], '0x10', 1),
      rpc('eth_getBalance', ['0xabc', 'latest'], '0x0', 2),
      rpc('system.listMethods', {}, ['a', 'b'], 3),
    ])
    expect(summary(found)).toEqual({
      parameter: 'method',
      in: 'json',
      values: [
        ['eth_blockNumber', 1],
        ['eth_getBalance', 1],
        ['system.listMethods', 1],
      ],
    })
  })

  it('ignores a JSON `method` field without a JSON-RPC envelope', () => {
    const call = (method: string, body: Record<string, unknown>, response: unknown): Exchange => exchange({
      method: 'POST',
      url: 'https://shop.example.test/api/pay',
      requestBody: jsonBody({ method, ...body }),
      responseBody: jsonBody(response),
    })
    expect(detectDispatcher([
      call('card', { last4: '1111' }, {
        ok: { authorised: true },
      }),
      call('upi', { vpa: 'a@b' }, {
        pending: { ref: 'x' },
      }),
    ])).toBeNull()
  })

  it('does not take type=json and type=xml for functions, nor a format parameter', () => {
    const same = {
      items: [
        { id: 1, name: 'a' },
      ],
    }
    expect(detectDispatcher([
      get({ type: 'json', q: 'a' }, same),
      get({ type: 'xml', q: 'a' }, same),
      get({ type: 'csv', q: 'a' }, same),
    ])).toBeNull()
    expect(detectDispatcher([
      exchange({
        url: `${QUOTE}?format=json`,
        responseBody: jsonBody(same),
      }),
      exchange({
        url: `${QUOTE}?format=xml`,
        responseBody: textBody('<items/>', 'application/xml'),
      }),
    ])).toBeNull()
  })

  it('needs every pair of unlike responses, and three values, before a `type` is a dispatcher', () => {
    const filter = [
      get({ type: 'fruit', q: 'a' }, {
        items: [
          { id: 1, name: 'apple' },
        ],
      }),
      get({ type: 'vegetable', q: 'a' }, {
        items: [
          { id: 2, name: 'leek' },
        ],
      }),
      get({ type: 'grain', q: 'a', page: '2' }, {
        items: [
          { id: 3, name: 'rice' },
        ],
      }),
    ]
    expect(detectDispatcher(filter)).toBeNull()
    expect(summary(detectDispatcher([
      get({ type: 'getStores' }, {
        stores: [
          { slug: 'a', open: true },
        ],
      }),
      get({ type: 'getDeals' }, {
        deals: [
          { code: 'x', percent: 10 },
        ],
      }),
      get({ type: 'getHours' }, {
        hours: [
          { day: 'mon', from: '8', to: '20' },
        ],
      }),
    ]))).toMatchObject({
      parameter: 'type',
      values: [
        ['getDeals', 1],
        ['getHours', 1],
        ['getStores', 1],
      ],
    })
  })

  it('does not split on a sort or filter parameter whose values share parameters and shape', () => {
    const list = (op: string, rows: Array<{ id: number, title: string }>): Exchange => get({ op, page: '1' }, { results: rows, total: rows.length })
    expect(detectDispatcher([
      list('newest', [
        { id: 1, title: 'a' },
      ]),
      list('popular', [
        { id: 2, title: 'b' },
      ]),
      list('trending', [
        { id: 3, title: 'c' },
      ]),
    ])).toBeNull()
    expect(detectDispatcher([
      get({ cmd: 'asc', field: 'price' }, {
        rows: [
          { id: 1 },
        ],
      }),
      get({ cmd: 'desc', field: 'name' }, {
        rows: [
          { id: 2 },
        ],
      }),
    ])).toBeNull()
  })

  it('needs at least two values', () => {
    expect(detectDispatcher([
      get({ functionName: 'getSymbolData', symbol: 'A' }, {
        a: { b: 1 },
      }),
      get({ functionName: 'getSymbolData', symbol: 'B', extra: '1' }, {
        c: { d: 1 },
      }),
    ])).toBeNull()
  })

  it('does not take ids, numbers, symbols or free text for function names', () => {
    const pairOf = (a: string, b: string): Exchange[] => [
      get({ action: a, x: '1' }, {
        first: { a: 1 },
      }),
      get({ action: b }, {
        second: { b: 2 },
      }),
    ]
    expect(detectDispatcher(pairOf('123', '456'))).toBeNull()
    expect(detectDispatcher(pairOf('RELIANCE', 'TCS'))).toBeNull()
    expect(detectDispatcher(pairOf('550e8400-e29b-41d4-a716-446655440000', 'getX'))).toBeNull()
    expect(detectDispatcher(pairOf('deadbeef42', 'getX'))).toBeNull()
    expect(detectDispatcher(pairOf('order20240101', 'getX'))).toBeNull()
    expect(detectDispatcher(pairOf('buy milk today', 'getX'))).toBeNull()
  })

  it('needs every request to send the parameter', () => {
    const calls = nse()
    calls.push(get({ symbol: 'RELIANCE' }, {
      other: { shape: 1 },
    }))
    expect(detectDispatcher(calls)).toBeNull()
  })

  it('never looks at GraphQL requests or WebSocket stand-ins', () => {
    expect(detectDispatcher(nse().map(item => ({ ...item, resourceType: 'websocket' })))).toBeNull()
  })
})
