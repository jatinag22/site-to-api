/**
 * Hand-built exchanges of two dispatcher endpoints (decision 0039): an NSE-like GET with
 * `functionName` in the query string and a WordPress-like `admin-ajax.php` POST with `action`
 * as a form field. Each function sends its own parameters and gets its own response shape.
 */
import type { Exchange } from '../src/model'
import { exchange, formBody, jsonBody } from './helpers'

export function dispatchExchanges(host: string): Exchange[] {
  const quote = (query: Record<string, string>, response: unknown): Exchange => exchange({
    url: `https://${host}/api/quote?${new URLSearchParams(query).toString()}`,
    responseBody: jsonBody(response),
  })
  const ajax = (fields: Record<string, string>, response: unknown): Exchange => exchange({
    method: 'POST',
    url: `https://${host}/wp-admin/admin-ajax.php`,
    requestBody: formBody(fields),
    responseBody: jsonBody(response),
  })
  return [
    quote({ functionName: 'getSymbolData', symbol: 'RELIANCE', series: 'EQ' }, {
      equity: [
        { price: 1, change: 2 },
      ],
    }),
    quote({ functionName: 'getSymbolData', symbol: 'TCS', series: 'EQ' }, {
      equity: [
        { price: 3, change: 4 },
      ],
    }),
    quote({ functionName: 'getMarketStatus' }, {
      marketState: [
        { market: 'CM', status: 'Open' },
      ],
    }),
    ajax({ action: 'load_more', page: '2' }, {
      posts: [
        { title: 'a', link: '/a' },
      ],
    }),
    ajax({ action: 'load_more', page: '3' }, {
      posts: [
        { title: 'b', link: '/b' },
      ],
    }),
    ajax({ action: 'heartbeat' }, {
      tick: { server_time: 1, interval: 60 },
    }),
  ]
}
