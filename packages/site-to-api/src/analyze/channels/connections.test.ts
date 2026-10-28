import type { CaptureEvent } from '../../model'
import { describe, expect, it } from 'vitest'
import { loadedSession, socketEvents } from '../../../test/helpers'
import { channelExchanges, collectConnections, parseFrameJson } from './connections'

const URL = 'wss://shop.test/ws/ticker'

describe('collectConnections', () => {
  it('splits events by socket number and parses JSON frames', () => {
    const events: CaptureEvent[] = [
      ...socketEvents({
        url: URL,
        socket: 0,
        frames: [
          ['>', '{"type":"subscribe","productId":7}'],
          ['<', 'ping'],
        ],
      }),
      ...socketEvents({
        url: URL,
        socket: 1,
        openedAt: 1_700_000_000_005,
        frames: [
          ['<', '[1,2]'],
        ],
      }),
    ].sort((a, b) => a.ts - b.ts)
    const connections = collectConnections([
      loadedSession('s1', events),
    ])
    expect(connections.map(connection => connection.id)).toEqual(['s1:ws:0', 's1:ws:1'])
    expect(connections[0]).toMatchObject({
      scheme: 'wss',
      host: 'shop.test',
      path: '/ws/ticker',
      query: [],
    })
    expect(connections[0]!.frames.map(frame => [frame.direction, frame.json])).toEqual([
      [
        'sent',
        { type: 'subscribe', productId: 7 },
      ],
      ['received', undefined],
    ])
    expect(connections[1]!.frames.map(frame => frame.json)).toEqual([
      [1, 2],
    ])
  })

  it('matches frames to the latest open socket of the URL in captures without socket numbers', () => {
    const events: CaptureEvent[] = [
      ...socketEvents({
        url: URL,
        frames: [
          ['>', 'a'],
        ],
        close: true,
      }),
      ...socketEvents({
        url: URL,
        openedAt: 1_700_000_001_000,
        frames: [
          ['>', 'b'],
          ['<', 'c'],
        ],
      }),
    ]
    const connections = collectConnections([
      loadedSession('s1', events),
    ])
    expect(connections.map(connection => connection.frames.map(frame => frame.data))).toEqual([
      ['a'],
      ['b', 'c'],
    ])
  })

  it('keeps binary frames as base64 and never parses them', () => {
    const connections = collectConnections([
      loadedSession('s1', socketEvents({
        url: URL,
        socket: 0,
        frames: [
          [
            '<',
            new Uint8Array([123, 125]),
          ],
        ],
      })),
    ])
    expect(connections[0]!.frames[0]).toMatchObject({ binary: true, data: 'e30=', json: undefined })
  })

  it('counts frames whose open event is missing and ignores other schemes', () => {
    const [, ...frames] = socketEvents({
      url: URL,
      frames: [
        ['<', 'x'],
      ],
    })
    const events: CaptureEvent[] = [
      ...frames,
      ...socketEvents({
        url: 'https://shop.test/not-a-socket',
        frames: [
          ['<', 'y'],
        ],
      }),
      ...socketEvents({
        url: 'not a url',
        pageUrl: 'https://shop.test/',
        frames: [
          ['<', 'z'],
        ],
      }),
    ]
    const connections = collectConnections([
      loadedSession('s1', events),
    ])
    expect(connections).toHaveLength(1)
    expect(connections[0]!.frames.map(frame => frame.data)).toEqual(['x'])
  })

  it('orders connections by session id', () => {
    const connections = collectConnections([
      loadedSession('b', socketEvents({ url: URL, frames: [] })),
      loadedSession('a', socketEvents({ url: URL, frames: [] })),
    ])
    expect(connections.map(connection => connection.sessionId)).toEqual(['a', 'b'])
  })
})

describe('parseFrameJson', () => {
  it('reads objects and arrays only', () => {
    expect(parseFrameJson(' {"a":1} ')).toEqual({ a: 1 })
    expect(parseFrameJson('42')).toBeUndefined()
    expect(parseFrameJson('"hi"')).toBeUndefined()
    expect(parseFrameJson('{broken')).toBeUndefined()
  })
})

describe('channelExchanges', () => {
  it('stands in for the URL and each frame; only the URL and the first client frames are traced', () => {
    const frames: Array<['>' | '<', string]> = Array.from({ length: 25 }, (_, index) => ['>', `{"seq":${index}}`])
    const connections = collectConnections([
      loadedSession('s1', socketEvents({
        url: `${URL}?room=lobby`,
        socket: 0,
        frames: [
          ['<', '{"type":"hello"}'],
          ...frames,
        ],
      })),
    ])
    const { exchanges, standIns } = channelExchanges(connections)
    expect(exchanges).toHaveLength(27)
    const url = exchanges[0]!
    expect(url.request.query).toEqual([
      { name: 'room', value: 'lobby' },
    ])
    expect(url.kind).toBe('api')
    expect(standIns.get(url.id)?.frame).toBeNull()
    const received = exchanges[1]!
    expect(received.kind).toBe('noise')
    expect(received.response.body?.json).toEqual({ type: 'hello' })
    const sent = exchanges.slice(2)
    expect(sent.filter(exchange => exchange.kind === 'api')).toHaveLength(20)
    expect(sent[0]!.request.body?.json).toEqual({ seq: 0 })
    expect(new Set(exchanges.map(exchange => exchange.id)).size).toBe(exchanges.length)
    expect(exchanges.every(exchange => exchange.id.startsWith('s1:ws:0:'))).toBe(true)
  })
})
