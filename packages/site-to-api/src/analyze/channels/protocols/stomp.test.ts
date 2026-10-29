import { describe, expect, it } from 'vitest'
import { stomp } from './stomp'
import { rawFrames, readAll } from './test-frames'

describe('stomp decoder', () => {
  it('reads frames, names them by destination and keeps headers and body as the payload', () => {
    const frames = rawFrames([
      ['>', 'CONNECT\naccept-version:1.2\nhost:example.test\nlogin:guest\npasscode:hunter2\n\n\0'],
      ['<', 'CONNECTED\nversion:1.2\nheart-beat:0,0\n\n\0'],
      ['>', 'SUBSCRIBE\nid:sub-0\ndestination:/topic/game/77812\n\n\0'],
      ['<', 'MESSAGE\ndestination:/topic/game/77812\nsubscription:sub-0\nmessage-id:9\ncontent-type:application/json\n\n{"score":[1,0]}\0'],
      ['>', 'SEND\ndestination:/app/chat\n\nhello\0\n'],
      ['<', '\n'],
      ['>', 'DISCONNECT\nreceipt:77\n\n\0'],
    ])
    expect(readAll(stomp, frames)).toEqual([
      ['CONNECT CONNECT'],
      ['CONNECTED CONNECTED'],
      ['SUBSCRIBE /topic/game/77812'],
      ['MESSAGE /topic/game/77812'],
      ['SEND /app/chat'],
      ['heart-beat heart-beat'],
      ['DISCONNECT DISCONNECT'],
    ])
    const session = stomp.start()
    const decoded = frames.map(frame => session.read(frame)?.[0])
    expect(session.version()).toBe('1.2')
    expect(decoded[0]).toMatchObject({
      role: 'auth',
      payload: {
        headers: {
          'accept-version': '1.2',
          'host': 'example.test',
          'login': 'guest',
          'passcode': 'hunter2',
        },
      },
    })
    expect(decoded[2]).toMatchObject({ role: 'subscribe', wire: 'SUBSCRIBE\\ndestination:{0}\\nid:…\\n\\n\\0' })
    expect(decoded[3]?.payload).toEqual({
      headers: { 'subscription': 'sub-0', 'message-id': '9', 'content-type': 'application/json' },
      body: {
        score: [1, 0],
      },
    })
    expect(decoded[4]?.payload).toEqual({ body: 'hello' })
  })

  it('unescapes header values and rejects frames without NUL or with unknown commands', () => {
    const session = stomp.start()
    expect(session.read({ direction: 'received', data: 'MESSAGE\ndestination:/q/a\\cb\n\n\0', binary: false })?.[0]?.name).toEqual(['/q/a:b'])
    expect(readAll(stomp, rawFrames([
      ['>', 'SEND\ndestination:/x\n\nbody'],
      ['>', 'HELLO\n\n\0'],
      ['>', 'SEND\nbad header\n\n\0'],
    ]))).toEqual([null, null, null])
  })

  it('takes STOMP subprotocols as a hint', () => {
    expect(stomp.hint({
      path: '/ws',
      query: [],
      subprotocols: ['v12.stomp', 'v11.stomp'],
    })).toBe('subprotocol v12.stomp')
  })
})
