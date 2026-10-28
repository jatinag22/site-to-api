import type { Exchange, Operation, ValueTrace } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody, textBody } from '../../../test/helpers'
import { createLocationGeneralizer } from './items'

function stub(operationId: string): Operation {
  return {
    operationId,
    host: 'shop.test',
    method: 'GET',
    path: '/',
    kind: 'page',
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses: [],
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges: [],
  }
}

function htmlTrace(producer: Exchange, selector: string): ValueTrace {
  return {
    exchangeId: 'consumer',
    location: { in: 'cookie', name: 'store' },
    value: 'v',
    origin: {
      kind: 'response',
      exchangeId: producer.id,
      location: {
        in: 'html',
        selector,
        attr: 'href',
        pattern: null,
      },
      transform: 'none',
    },
  }
}

describe('createLocationGeneralizer', () => {
  const list = exchange({
    url: 'https://shop.test/api/list',
    responseBody: jsonBody({
      items: [
        { id: 1 },
        { id: 2 },
      ],
    }),
  })
  const pageA = exchange({
    url: 'https://shop.test/stores',
    responseBody: textBody('<ul></ul>'),
  })
  const pageB = exchange({
    url: 'https://shop.test/stores',
    sessionId: 's2',
    responseBody: textBody('<ul></ul>'),
  })
  const other = exchange({
    url: 'https://shop.test/deals',
    responseBody: textBody('<ul></ul>'),
  })
  const operations = new Map([
    [
      pageA.id,
      stub('getStores'),
    ],
    [
      pageB.id,
      stub('getStores'),
    ],
    [
      other.id,
      stub('getDeals'),
    ],
    [
      list.id,
      stub('getApiList'),
    ],
  ])
  const byId = new Map([list, pageA, pageB, other].map(item => [item.id, item]))
  const traces = [
    htmlTrace(pageA, 'ul > li:nth-of-type(1) > a'),
    htmlTrace(pageB, 'ul > li:nth-of-type(2) > a'),
    htmlTrace(other, 'ul > li:nth-of-type(3) > a'),
  ]
  const generalize = createLocationGeneralizer(traces, byId, id => operations.get(id))

  it('writes array indexes as `*`', () => {
    expect(generalize(list.id, { in: 'body', pointer: '/items/1/id' })).toEqual({
      location: { in: 'body', pointer: '/items/*/id' },
      repeated: false,
    })
  })

  it('drops positions that varied across samples of one producing operation', () => {
    expect(generalize(pageA.id, {
      in: 'html',
      selector: 'ul > li:nth-of-type(1) > a',
      attr: 'href',
      pattern: null,
    })).toEqual({
      location: {
        in: 'html',
        selector: 'ul > li > a',
        attr: 'href',
        pattern: null,
      },
      repeated: true,
    })
  })

  it('leaves a selector seen at one position only, and other locations, unchanged', () => {
    const deal = {
      in: 'html' as const,
      selector: 'ul > li:nth-of-type(3) > a',
      attr: 'href',
      pattern: null,
    }
    expect(generalize(other.id, deal)).toEqual({ location: deal, repeated: false })
    expect(generalize(list.id, { in: 'set-cookie', name: 'sid' })).toEqual({
      location: { in: 'set-cookie', name: 'sid' },
      repeated: false,
    })
  })
})
