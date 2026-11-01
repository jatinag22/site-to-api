/**
 * Hand-built HAR files in the shapes browsers and proxies export (decision 0057). Every value is
 * invented: the host is shop.test, cookies and tokens are made up.
 */
import { Buffer } from 'node:buffer'

interface EntryInit {
  url: string
  method?: string
  started: string
  status?: number
  mimeType?: string
  text?: string
  encoding?: string
  requestHeaders?: Array<{ name: string, value: string }>
  postData?: { mimeType: string, text: string }
  extra?: Record<string, unknown>
}

/** One HAR entry with the fields every exporter writes. */
export function harEntry(init: EntryInit): Record<string, unknown> {
  return {
    startedDateTime: init.started,
    time: 12,
    request: {
      method: init.method ?? 'GET',
      url: init.url,
      httpVersion: 'HTTP/1.1',
      headers: init.requestHeaders ?? [
        { name: 'User-Agent', value: 'Mozilla/5.0 (Test) Browser/1.0' },
      ],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: init.postData ? init.postData.text.length : 0,
      ...(init.postData
        ? { postData: init.postData }
        : {}),
    },
    response: {
      status: init.status ?? 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [
        { name: 'Content-Type', value: init.mimeType ?? 'application/json' },
      ],
      cookies: [],
      content: {
        size: init.text?.length ?? 0,
        mimeType: init.mimeType ?? 'application/json',
        ...(init.text === undefined
          ? {}
          : { text: init.text }),
        ...(init.encoding === undefined
          ? {}
          : { encoding: init.encoding }),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 10, receive: 2 },
    ...init.extra,
  }
}

const SCRIPT = 'async function loadItems(){const r=await fetch("/api/items");return r.json()}\nfunction search(q){return fetch("/api/search",{method:"POST",body:JSON.stringify({q})})}\n'

/** Chrome / Edge DevTools "Save all as HAR (with content)". */
export function chromeHar(): Record<string, unknown> {
  const stack = {
    callFrames: [
      {
        functionName: 'loadItems',
        url: 'https://shop.test/static/app.js',
        lineNumber: 0,
        columnNumber: 41,
      },
    ],
    parent: {
      description: 'Promise.then',
      callFrames: [
        {
          functionName: 'boot',
          url: 'https://shop.test/static/app.js',
          lineNumber: 1,
          columnNumber: 3,
        },
      ],
    },
  }
  return {
    log: {
      version: '1.2',
      creator: { name: 'WebInspector', version: '537.36' },
      pages: [
        {
          startedDateTime: '2026-01-01T10:00:00.000Z',
          id: 'page_1',
          title: 'Shop - Home',
          pageTimings: {},
        },
      ],
      entries: [
        harEntry({
          url: 'https://shop.test/',
          started: '2026-01-01T10:00:00.000Z',
          mimeType: 'text/html',
          text: '<html><title>Shop - Home</title></html>',
          extra: {
            _resourceType: 'document',
            pageref: 'page_1',
            _initiator: { type: 'other' },
          },
        }),
        harEntry({
          url: 'https://shop.test/static/app.js',
          started: '2026-01-01T10:00:00.100Z',
          mimeType: 'application/javascript',
          text: SCRIPT,
          extra: {
            _resourceType: 'script',
            pageref: 'page_1',
            _initiator: { type: 'parser', url: 'https://shop.test/' },
          },
        }),
        harEntry({
          url: 'https://shop.test/api/items',
          started: '2026-01-01T10:00:00.300Z',
          text: '{"items":[{"id":1042,"name":"Peanuts","price":3.5}]}',
          extra: {
            _resourceType: 'fetch',
            pageref: 'page_1',
            _initiator: { type: 'script', stack },
          },
        }),
        harEntry({
          url: 'https://shop.test/api/search',
          method: 'POST',
          started: '2026-01-01T10:00:02.000Z',
          postData: { mimeType: 'application/json', text: '{"q":"nuts"}' },
          text: '{"results":[{"id":1042}]}',
          extra: {
            _resourceType: 'xhr',
            pageref: 'page_1',
            _initiator: {
              type: 'script',
              stack: {
                callFrames: [
                  {
                    functionName: 'search',
                    url: 'https://shop.test/static/app.js',
                    lineNumber: 1,
                    columnNumber: 28,
                  },
                ],
              },
            },
          },
        }),
        harEntry({
          url: 'https://shop.test/logo.png',
          started: '2026-01-01T10:00:00.200Z',
          mimeType: 'image/png',
          text: 'iVBORw0KGgo=',
          encoding: 'base64',
          extra: { _resourceType: 'image', pageref: 'page_1' },
        }),
        harEntry({
          url: 'wss://shop.test/ws/ticker',
          started: '2026-01-01T10:00:01.000Z',
          status: 101,
          mimeType: 'x-unknown',
          extra: {
            _resourceType: 'websocket',
            pageref: 'page_1',
            _webSocketMessages: [
              {
                type: 'send',
                time: 1767261601.1,
                opcode: 1,
                data: '{"type":"subscribe","productId":1042}',
              },
              {
                type: 'receive',
                time: 1767261601.2,
                opcode: 1,
                data: '{"type":"tick","productId":1042,"price":3.6}',
              },
              {
                type: 'receive',
                time: 1767261601.3,
                opcode: 2,
                data: 'AQID',
              },
            ],
          },
        }),
      ],
    },
  }
}

/** Firefox DevTools "Save All As HAR": no `_resourceType`, base64 bodies, the URL as page title. */
export function firefoxHar(): Record<string, unknown> {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Firefox', version: '140.0' },
      browser: { name: 'Firefox', version: '140.0' },
      pages: [
        {
          startedDateTime: '2026-01-02T09:00:00.000+01:00',
          id: 'page_1',
          title: 'https://shop.test/products',
          pageTimings: {},
        },
      ],
      entries: [
        harEntry({
          url: 'https://shop.test/products',
          started: '2026-01-02T09:00:00.000+01:00',
          mimeType: 'text/html; charset=utf-8',
          text: '<html><body>products</body></html>',
          extra: { pageref: 'page_1' },
        }),
        harEntry({
          url: 'https://shop.test/api/products?page=1',
          started: '2026-01-02T09:00:00.500+01:00',
          text: Buffer.from('{"products":[{"id":7,"title":"Cashews"}]}').toString('base64'),
          encoding: 'base64',
          requestHeaders: [
            { name: 'Sec-Fetch-Dest', value: 'empty' },
            { name: 'Referer', value: 'https://shop.test/products' },
          ],
          extra: { pageref: 'page_1' },
        }),
        harEntry({
          url: 'https://shop.test/old',
          started: '2026-01-02T09:00:01.000+01:00',
          status: 301,
          mimeType: 'text/html',
          extra: { pageref: 'page_1' },
        }),
      ],
    },
  }
}

/** Safari Web Inspector export: no pages, no cookies arrays, a response without a body. */
export function safariHar(): Record<string, unknown> {
  const entry = harEntry({ url: 'https://shop.test/api/cart', started: '2026-01-03T08:00:00.000Z' })
  const request = entry.request as Record<string, unknown>
  const response = entry.response as Record<string, unknown>
  delete request.cookies
  delete response.cookies
  return {
    log: {
      version: '1.2',
      creator: { name: 'WebKit Web Inspector', version: '1.0' },
      entries: [
        harEntry({
          url: 'https://shop.test/cart',
          started: '2026-01-03T07:59:59.000Z',
          mimeType: 'text/html',
          text: '<html>cart</html>',
        }),
        entry,
      ],
    },
  }
}
