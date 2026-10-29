import { describe, expect, it } from 'vitest'
import { phoenix } from './phoenix'
import { rawFrames, readAll } from './test-frames'

describe('phoenix decoder', () => {
  it('reads serializer 2.0 arrays as topic:event', () => {
    const frames = rawFrames([
      ['>', '["3","3","room:4821","phx_join",{"token":"abc"}]'],
      ['<', '["3","3","room:4821","phx_reply",{"status":"ok","response":{}}]'],
      ['<', '[null,null,"room:4821","new_msg",{"body":"hi"}]'],
      ['>', '[null,"4","phoenix","heartbeat",{}]'],
    ])
    expect(readAll(phoenix, frames)).toEqual([
      ['phx_join room:4821:phx_join'],
      ['phx_reply room:4821:phx_reply'],
      ['push room:4821:new_msg'],
      ['heartbeat phoenix:heartbeat'],
    ])
    const session = phoenix.start()
    const decoded = frames.map(frame => session.read(frame)?.[0])
    expect(session.version()).toBe('2.0.0')
    expect(decoded[0]).toMatchObject({
      role: 'subscribe',
      wire: '[<joinRef>,<ref>,"{0}","{1}",<payload>]',
      payload: { token: 'abc' },
    })
    expect(decoded[3]).toMatchObject({ role: 'keepalive', payload: undefined })
  })

  it('reads the 1.0 object form and rejects other arrays', () => {
    expect(readAll(phoenix, rawFrames([
      ['>', '{"topic":"rooms:lobby","event":"phx_join","payload":{},"ref":"1"}'],
      ['<', '[1,2,3,4,5]'],
      ['<', '["a","b","c","d"]'],
      ['<', '{"topic":"t","event":"e"}'],
    ]))).toEqual([
      ['phx_join rooms:lobby:phx_join'],
      null,
      null,
      null,
    ])
  })

  it('needs a Phoenix-only message to be strong, and calls application events pushes', () => {
    const session = phoenix.start()
    const tuple = session.read({ direction: 'received', data: '[1712345678,1,"BTC-USD","trade",{"p":100}]', binary: false })?.[0]
    expect(tuple).toMatchObject({ frame: 'push', strong: false })
    const odd = session.read({ direction: 'received', data: '[null,null,"room:lobby","phx_` evil](http://x.test)",{}]', binary: false })?.[0]
    expect(odd).toMatchObject({ frame: 'push', role: null })
    const proto = session.read({ direction: 'received', data: '[null,null,"room:lobby","constructor",{}]', binary: false })?.[0]
    expect(proto?.role).toBeNull()
    expect(session.read({ direction: 'received', data: '[null,null,"rooms:x","heartbeat",{}]', binary: false })?.[0]).toMatchObject({ frame: 'push', strong: false })
    expect(session.read({ direction: 'sent', data: '[null,"4","phoenix","heartbeat",{}]', binary: false })?.[0]).toMatchObject({ frame: 'heartbeat', strong: true })
  })

  it('takes /websocket with vsn as a hint', () => {
    expect(phoenix.hint({
      path: '/socket/websocket',
      query: [
        { name: 'vsn', value: '2.0.0' },
      ],
      subprotocols: [],
    })).toBe('URL path ends in /websocket, vsn=2.0.0')
    expect(phoenix.hint({ path: '/socket/websocket', query: [], subprotocols: [] })).toBeNull()
  })
})
