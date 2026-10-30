import { describe, expect, it } from 'vitest'
import { decodeConnection } from './index'
import { primus } from './primus'
import { rawFrames, readAll } from './test-frames'

const PRIMUS = {
  path: '/primus-v8/',
  query: [
    { name: 'EIO', value: '4' },
    { name: '_primuscb', value: 'Abc123' },
  ],
  subprotocols: [],
}
const PLAIN = { path: '/live', query: [], subprotocols: [] }

describe('primus decoder', () => {
  it('reads Primus over Engine.IO: open, probes, heartbeats and data named by `type`', () => {
    const frames = rawFrames([
      ['>', '2probe'],
      ['<', '3probe'],
      ['>', '5'],
      ['>', '4{"type":"/api/v1/subscribe","requestId":"r-1","keys":["doc/1"]}'],
      ['<', '4{"type":"notification","key":"doc/1","version":3}'],
      ['<', '4"primus::ping::1700000000000"'],
      ['>', '4"primus::pong::1700000000000"'],
      ['<', '4[1,2]'],
    ])
    expect(readAll(primus, frames)).toEqual([
      ['ping ping'],
      ['pong pong'],
      ['upgrade upgrade'],
      ['message /api/v1/subscribe'],
      ['message notification'],
      ['ping ping'],
      ['pong pong'],
      ['message message'],
    ])
    const reader = primus.start()
    const read = frames.map(frame => reader.read(frame)?.[0])
    expect(read[4]).toMatchObject({
      payload: { type: 'notification', key: 'doc/1', version: 3 },
      wire: '4{"type":"{0}",…}',
    })
    expect(read[5]).toMatchObject({ role: 'keepalive', strong: true, wire: '4"primus::ping::<ms>"' })
    expect(reader.version()).toBe('Engine.IO transformer')
  })

  it('reads Primus over plain WebSocket frames', () => {
    const reader = primus.start()
    const frames = rawFrames([
      ['<', '"primus::ping::1700000000001"'],
      ['>', '{"event":"join","room":"lobby"}'],
    ])
    expect(frames.map(frame => reader.read(frame)?.map(item => `${item.frame} ${item.name.join('')}`))).toEqual([
      ['ping ping'],
      ['message join'],
    ])
    expect(reader.version()).toBe('WebSocket transformer')
  })

  it('is detected from its path or a heartbeat, and leaves other text alone', () => {
    const frames = rawFrames([
      ['<', '0{"sid":"invented-sid","upgrades":[],"pingInterval":25000}'],
      ['<', '4{"type":"notification","key":"doc/1"}'],
      ['<', '4{"type":"notification","key":"doc/2"}'],
    ])
    expect(decodeConnection(frames, PRIMUS).protocol).toMatchObject({
      id: 'primus',
      evidence: ['URL path or _primuscb query parameter names Primus', 'frames'],
    })
    // Without the path, a heartbeat shows it.
    expect(decodeConnection(frames, PLAIN).protocol).toBeNull()
    expect(decodeConnection([
      ...frames,
      ...rawFrames([
        ['<', '4"primus::ping::1"'],
      ]),
    ], PLAIN).protocol?.id).toBe('primus')
    const reader = primus.start()
    expect(reader.read({ direction: 'received', data: '4not json', binary: false })).toBeNull()
    expect(reader.read({ direction: 'received', data: '9', binary: false })).toBeNull()
  })
})
