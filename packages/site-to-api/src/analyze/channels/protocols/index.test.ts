import { describe, expect, it } from 'vitest'
import { decodeConnection } from './index'
import { rawFrames } from './test-frames'

const plainHandshake = { path: '/ws', query: [], subprotocols: [] }

describe('decodeConnection', () => {
  it('detects Socket.IO from the frames alone and names every frame', () => {
    const decoded = decodeConnection(rawFrames([
      ['<', '0{"sid":"a"}'],
      ['>', '40'],
      ['<', '42["tick",{"p":1}]'],
    ]), plainHandshake)
    expect(decoded.protocol).toEqual({
      id: 'socket.io',
      version: null,
      evidence: ['frames'],
      wrapper: null,
    })
    expect(decoded.frames.map(records => records.map(record => record.decoded?.frame))).toEqual([
      ['open'],
      ['connect'],
      ['event'],
    ])
  })

  it('leaves plain JSON and text alone: the ticker, Binance and an echo server', () => {
    for (const frames of [
      rawFrames([
        ['>', '{"type":"subscribe","productId":7}'],
        ['<', '{"type":"hello","channel":"prices"}'],
        ['<', '{"type":"tick","seq":1}'],
      ]),
      rawFrames([
        ['>', '{"method":"SUBSCRIBE","params":["btcusdt@trade"],"id":1}'],
        ['<', '{"result":null,"id":1}'],
        ['<', '{"stream":"btcusdt@trade","data":{"e":"trade"}}'],
      ]),
      rawFrames([
        ['>', 'hello'],
        ['<', 'hello'],
        ['<', '42'],
      ]),
      // Phoenix-shaped tuples from a trading feed: same shape, no Phoenix event.
      rawFrames(Array.from({ length: 5 }, (_, i): ['<', string] => [
        '<',
        JSON.stringify([
          1712345678 + i,
          i,
          'BTC-USD',
          'trade',
          { p: 100 + i },
        ]),
      ])),
    ]) {
      const decoded = decodeConnection(frames, plainHandshake)
      expect(decoded.protocol).toBeNull()
      expect(decoded.frames.flat().every(record => record.decoded === null)).toBe(true)
    }
  })

  it('needs nearly every frame to decode without a hint, fewer with one', () => {
    const frames = rawFrames([
      ['<', '42["a"]'],
      ['<', 'x'],
      ['<', 'y'],
    ])
    expect(decodeConnection(frames, plainHandshake).protocol).toBeNull()
    const hinted = decodeConnection(rawFrames([
      ['<', '42["a"]'],
      ['<', '42["b"]'],
      ['<', 'y'],
    ]), {
      path: '/socket.io/',
      query: [
        { name: 'EIO', value: '4' },
      ],
      subprotocols: [],
    })
    expect(hinted.protocol).toEqual({
      id: 'socket.io',
      version: 'Engine.IO 4',
      evidence: ['URL path ends in /socket.io/', 'frames'],
      wrapper: null,
    })
    expect(hinted.frames[2]?.[0]?.decoded).toBeNull()
  })

  it('takes a protocol from the subprotocol even before any frame', () => {
    expect(decodeConnection([], {
      path: '/graphql',
      query: [],
      subprotocols: ['graphql-transport-ws'],
    }).protocol).toMatchObject({ id: 'graphql-ws', version: 'graphql-transport-ws' })
  })

  it('splits frames that batch messages into one record each', () => {
    const decoded = decodeConnection(rawFrames([
      ['>', '{"protocol":"json","version":1}\x1E'],
      ['<', '{}\x1E{"type":1,"target":"A","arguments":[]}\x1E'],
    ]), plainHandshake)
    expect(decoded.protocol?.id).toBe('signalr')
    expect(decoded.frames[1]?.map(record => record.data)).toEqual(['{}\x1E', '{"type":1,"target":"A","arguments":[]}\x1E'])
  })

  it('unwraps SockJS around STOMP', () => {
    const decoded = decodeConnection(rawFrames([
      ['<', 'o'],
      ['>', '["CONNECT\\naccept-version:1.2\\n\\n\\u0000"]'],
      ['<', 'a["CONNECTED\\nversion:1.2\\n\\n\\u0000"]'],
      ['<', 'h'],
      ['<', 'a["MESSAGE\\ndestination:/topic/a\\n\\n{}\\u0000","MESSAGE\\ndestination:/topic/b\\n\\n{}\\u0000"]'],
    ]), { path: '/ws/123/abcdef/websocket', query: [], subprotocols: [] })
    expect(decoded.protocol).toEqual({
      id: 'stomp',
      version: '1.2',
      evidence: ['SockJS framing', 'frames'],
      wrapper: 'sockjs',
    })
    expect(decoded.frames.map(records => records.map(record => `${record.decoded?.frame} ${record.decoded?.name.join('')}`))).toEqual([
      ['sockjs open sockjs open'],
      ['CONNECT CONNECT'],
      ['CONNECTED CONNECTED'],
      ['sockjs heartbeat sockjs heartbeat'],
      ['MESSAGE /topic/a', 'MESSAGE /topic/b'],
    ])
  })
})
