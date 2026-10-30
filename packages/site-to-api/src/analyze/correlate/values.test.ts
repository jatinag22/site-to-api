import { describe, expect, it } from 'vitest'
import { exchange, jsonBody } from '../../../test/helpers'
import { annotateRpc } from '../rpc'
import { requestValues } from './values'

describe('requestValues', () => {
  it('reads the fields of a tRPC input instead of its JSON text', () => {
    const [call] = annotateRpc([
      exchange({
        url: `https://book.test/api/trpc/slots.list?input=${encodeURIComponent('{"json":{"slug":"demo-event","ids":[41]}}')}&lang=en`,
        responseBody: jsonBody({
          result: {
            data: { json: [] },
          },
        }),
      }),
    ])
    const values = call === undefined
      ? []
      : requestValues(call).filter(value => value.location.in === 'query')
    expect(values).toEqual([
      {
        location: { in: 'query', name: 'input', pointer: '/json/slug' },
        value: 'demo-event',
        name: 'slug',
      },
      {
        location: { in: 'query', name: 'input', pointer: '/json/ids/0' },
        value: '41',
        name: 'ids',
      },
      {
        location: { in: 'query', name: 'lang' },
        value: 'en',
        name: 'lang',
      },
    ])
  })

  it('keeps a JSON-looking query value whole when the call is not RPC', () => {
    const values = requestValues(exchange({ url: `https://book.test/api/x?input=${encodeURIComponent('{"a":1}')}` }))
    expect(values.filter(value => value.location.in === 'query')).toEqual([
      {
        location: { in: 'query', name: 'input' },
        value: '{"a":1}',
        name: 'input',
      },
    ])
  })
})
