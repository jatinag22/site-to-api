import { describe, expect, it } from 'vitest'
import { centrifugo } from './centrifugo'
import { rawFrames, readAll } from './test-frames'

describe('centrifugo decoder', () => {
  it('reads commands, replies named after their command and publications named after their channel', () => {
    const frames = rawFrames([
      ['>', '{"id":1,"connect":{"token":"jwt-here","name":"js"}}\n{"id":2,"subscribe":{"channel":"news"}}'],
      ['<', '{"id":1,"connect":{"client":"c1","version":"5.0.0"}}\n{"id":2,"subscribe":{}}'],
      ['<', '{"push":{"channel":"news","pub":{"data":{"title":"hi"}}}}'],
      ['<', '{}'],
      ['>', '{}'],
      ['>', '{"id":3,"rpc":{"method":"getScore","data":{}}}'],
    ])
    expect(readAll(centrifugo, frames)).toEqual([
      ['connect connect', 'subscribe news'],
      ['reply connect', 'reply news'],
      ['publication news'],
      ['ping ping'],
      ['ping ping'],
      ['rpc getScore'],
    ])
    const session = centrifugo.start()
    const decoded = frames.flatMap(frame => session.read(frame) ?? [])
    expect(session.version()).toBe('v4+')
    expect(decoded[0]).toMatchObject({ role: 'auth', wire: '{"id":<id>,"connect":<payload>}', data: '{"id":1,"connect":{"token":"jwt-here","name":"js"}}' })
    expect(decoded[1]).toMatchObject({
      role: 'subscribe',
      payload: { channel: 'news' },
    })
    expect(decoded[4]).toMatchObject({
      payload: {
        data: { title: 'hi' },
      },
      wire: '{"push":{"channel":"{0}","pub":<payload>}}',
    })
  })

  it('reads the v2 protocol with numeric methods', () => {
    const session = centrifugo.start()
    const frames = rawFrames([
      ['>', '{"id":1,"params":{"token":""}}'],
      ['>', '{"id":2,"method":1,"params":{"channel":"scores"}}'],
      ['<', '{"result":{"channel":"scores","data":{"data":{"home":2}}}}'],
    ])
    expect(frames.map(frame => session.read(frame)?.map(item => `${item.frame} ${item.name[0]} ${item.role}`))).toEqual([
      ['connect connect init'],
      ['subscribe scores subscribe'],
      ['publication scores data'],
    ])
    expect(session.version()).toBe('v2')
  })

  it('leaves other JSON alone, such as Binance subscriptions', () => {
    expect(readAll(centrifugo, rawFrames([
      ['>', '{"method":"SUBSCRIBE","params":["btcusdt@trade"],"id":1}'],
      ['<', '{"result":null,"id":1}'],
    ]))).toEqual([
      null,
      ['reply result'],
    ])
  })
})
