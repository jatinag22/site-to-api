import { describe, expect, it } from 'vitest'
import { exchange, jsonBody } from '../../../test/helpers'
import { annotateRpc } from './annotate'

const HOST = 'https://book.example'

function trpcGet(path: string, input: unknown, answer: unknown, extra = ''): ReturnType<typeof exchange> {
  return exchange({
    url: `${HOST}${path}?${extra}input=${encodeURIComponent(JSON.stringify(input))}`,
    responseBody: jsonBody(answer),
  })
}

describe('annotateRpc: tRPC', () => {
  it('marks an unbatched superjson query', () => {
    const [call] = annotateRpc([
      trpcGet('/api/trpc/slots/getRanges', {
        json: { slug: 'demo', from: '2030-01-01' },
        meta: { values: {} },
      }, {
        result: {
          data: {
            json: {
              starts: [1],
            },
          },
        },
      }),
    ])
    expect(call?.rpc).toEqual({
      protocol: 'trpc',
      procedure: 'slots/getRanges',
      jsonParam: 'input',
      superjson: true,
    })
    expect(call?.request.path).toBe('/api/trpc/slots/getRanges')
  })

  it('splits a batched GET into one unbatched call per procedure, each with its input and answer', () => {
    const calls = annotateRpc([
      trpcGet('/api/trpc/viewer.me,public.ping', {
        0: { json: null },
        1: {
          json: { n: 1 },
        },
      }, [
        {
          result: {
            data: {
              json: { id: 'u-1' },
            },
          },
        },
        {
          result: {
            data: { json: 'pong' },
          },
        },
      ], 'batch=1&'),
    ])
    expect(calls.map(call => [
      call.request.path,
      call.request.query,
      call.response.body?.json,
      call.rpc?.procedure,
    ])).toEqual([
      [
        '/api/trpc/viewer.me',
        [
          { name: 'input', value: '{"json":null}' },
        ],
        {
          result: {
            data: {
              json: { id: 'u-1' },
            },
          },
        },
        'viewer.me',
      ],
      [
        '/api/trpc/public.ping',
        [
          { name: 'input', value: '{"json":{"n":1}}' },
        ],
        {
          result: {
            data: { json: 'pong' },
          },
        },
        'public.ping',
      ],
    ])
    expect(calls[0]?.request.url).toBe(`${HOST}/api/trpc/viewer.me?input=%7B%22json%22%3Anull%7D`)
    expect(calls.map(call => call.id)).toEqual([
      expect.stringMatching(/:trpc:0$/),
      expect.stringMatching(/:trpc:1$/),
    ])
  })

  it('splits a batched POST body, keeping a router path shared by the batch', () => {
    const calls = annotateRpc([
      exchange({
        method: 'POST',
        url: `${HOST}/api/trpc/bookings/create,confirm?batch=1`,
        requestBody: jsonBody({
          0: {
            json: { slot: 1 },
          },
          1: {
            json: { id: 2 },
          },
        }),
        responseBody: jsonBody([
          {
            result: {
              data: {
                json: { ok: true },
              },
            },
          },
          {
            error: {
              json: { message: 'no' },
            },
          },
        ]),
      }),
    ])
    expect(calls.map(call => [call.request.path, call.request.body?.json, call.rpc?.jsonParam])).toEqual([
      [
        '/api/trpc/bookings/create',
        {
          json: { slot: 1 },
        },
        null,
      ],
      [
        '/api/trpc/bookings/confirm',
        {
          json: { id: 2 },
        },
        null,
      ],
    ])
  })

  it('leaves a /trpc/ path alone without tRPC evidence, and too-large batches', () => {
    const page = exchange({
      url: `${HOST}/docs/trpc/intro`,
      responseBody: jsonBody({ title: 'docs' }),
    })
    expect(annotateRpc([page])).toEqual([page])
    const huge = exchange({ url: `${HOST}/api/trpc/${Array.from({ length: 65 }, (_, i) => `p${i}`).join(',')}?batch=1` })
    expect(annotateRpc([huge])[0]?.rpc).toBeUndefined()
  })
})

describe('annotateRpc: Connect', () => {
  it('marks a POST with connect-protocol-version: 1 at /package.Service/Method', () => {
    const [call] = annotateRpc([
      exchange({
        method: 'POST',
        url: `${HOST}/demo.catalog.v1.ItemService/GetItems`,
        requestHeaders: { 'connect-protocol-version': '1', 'content-type': 'application/json' },
        requestBody: jsonBody({
          ids: ['a'],
        }),
        responseBody: jsonBody({ items: [] }),
      }),
    ])
    expect(call?.rpc).toEqual({
      protocol: 'connect',
      procedure: 'demo.catalog.v1.ItemService/GetItems',
      jsonParam: null,
      superjson: false,
    })
  })

  it('marks a GET call and its JSON message parameter', () => {
    const message = encodeURIComponent(JSON.stringify({ id: 'a' }))
    const [call] = annotateRpc([
      exchange({ url: `${HOST}/api/demo.catalog.v1.ItemService/GetItem?connect=v1&encoding=json&message=${message}` }),
    ])
    expect(call?.rpc).toMatchObject({ procedure: 'demo.catalog.v1.ItemService/GetItem', jsonParam: 'message' })
  })

  it('needs the Connect header or query, and a service path', () => {
    const plain = exchange({
      method: 'POST',
      url: `${HOST}/demo.catalog.v1.ItemService/GetItems`,
      requestBody: jsonBody({}),
    })
    const notService = exchange({
      method: 'POST',
      url: `${HOST}/api/items`,
      requestHeaders: { 'connect-protocol-version': '1', 'content-type': 'application/json' },
    })
    expect(annotateRpc([plain, notService]).map(call => call.rpc)).toEqual([undefined, undefined])
  })
})
