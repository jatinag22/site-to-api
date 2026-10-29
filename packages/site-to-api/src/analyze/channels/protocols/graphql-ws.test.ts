import { describe, expect, it } from 'vitest'
import { graphqlWs } from './graphql-ws'
import { rawFrames, readAll } from './test-frames'

describe('graphqlWs decoder', () => {
  it('names subscriptions and their results by GraphQL operation (graphql-transport-ws)', () => {
    const frames = rawFrames([
      ['>', '{"type":"connection_init","payload":{"authToken":"secret-1"}}'],
      ['<', '{"type":"connection_ack"}'],
      ['>', '{"id":"1","type":"subscribe","payload":{"query":"subscription OnScore($game: ID!) { score(game: $game) { home away } }","variables":{"game":"g7"}}}'],
      ['<', '{"id":"1","type":"next","payload":{"data":{"score":{"home":1,"away":0}}}}'],
      ['>', '{"id":"2","type":"subscribe","payload":{"query":"subscription { ticks { price } }"}}'],
      ['<', '{"id":"1","type":"complete"}'],
      ['>', '{"type":"ping"}'],
    ])
    const read = readAll(graphqlWs, frames)
    expect(read.slice(0, 4)).toEqual([
      ['connection_init connection_init'],
      ['connection_ack connection_ack'],
      ['subscribe OnScore'],
      ['next OnScore'],
    ])
    expect(read[4]?.[0]).toMatch(/^subscribe document-[0-9a-f]{12}$/)
    expect(read.slice(5)).toEqual([
      ['complete complete'],
      ['ping ping'],
    ])
    const session = graphqlWs.start()
    const decoded = frames.map(frame => session.read(frame)?.[0])
    expect(session.version()).toBe('graphql-transport-ws')
    expect(decoded[0]).toMatchObject({
      role: 'auth',
      payload: { authToken: 'secret-1' },
    })
    expect(decoded[2]).toMatchObject({ role: 'subscribe', wire: '{"id":"<id>","type":"subscribe","payload":<payload>}' })
  })

  it('reads subscriptions-transport-ws', () => {
    const session = graphqlWs.start()
    const frames = rawFrames([
      ['>', '{"type":"connection_init","payload":{}}'],
      ['>', '{"id":"1","type":"start","payload":{"operationName":"Prices","query":"subscription Prices { prices }","variables":{}}}'],
      ['<', '{"type":"ka"}'],
      ['<', '{"id":"1","type":"data","payload":{"data":{"prices":[]}}}'],
      ['>', '{"id":"1","type":"stop"}'],
    ])
    expect(frames.map(frame => session.read(frame)?.map(item => `${item.frame} ${item.name[0]} ${item.role}`))).toEqual([
      ['connection_init connection_init init'],
      ['start Prices subscribe'],
      ['ka ka keepalive'],
      ['data Prices data'],
      ['stop stop unsubscribe'],
    ])
    expect(session.version()).toBe('subscriptions-transport-ws')
  })

  it('rejects subscribe messages that carry no GraphQL and unknown types', () => {
    expect(readAll(graphqlWs, rawFrames([
      ['>', '{"type":"subscribe","productId":7}'],
      ['>', '{"type":"tick"}'],
    ]))).toEqual([null, null])
  })
})
