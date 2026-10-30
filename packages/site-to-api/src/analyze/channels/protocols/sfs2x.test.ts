import type { RawFrame } from './types'
import { describe, expect, it } from 'vitest'
import { base64, extensionPacket, packet, rawPacket, sfs } from '../binary/sfs2x-test-packets'
import { decodeConnection } from './index'
import { sfs2x } from './sfs2x'
import { readAll } from './test-frames'

function binaryFrames(frames: Array<[direction: '>' | '<', bytes: Uint8Array]>): RawFrame[] {
  return frames.map(([direction, bytes]) => ({
    direction: direction === '>'
      ? 'sent'
      : 'received',
    data: base64(bytes),
    binary: true,
  }))
}

const handshake = packet(0, 0, {
  api: sfs.string('1.8.4'),
  cl: sfs.string('JavaScript'),
})
const handshakeReply = packet(0, 0, {
  tk: sfs.string('0123456789abcdef0123456789abcdef'),
  ct: sfs.int(1024),
})
const login = packet(0, 1, {
  zn: sfs.string('game_zone'),
  un: sfs.string('bob'),
  pw: sfs.string('hunter2'),
  p: sfs.object({}),
})
const session = binaryFrames([
  ['>', handshake],
  ['<', handshakeReply],
  ['>', login],
  [
    '<',
    packet(0, 1, {
      un: sfs.string('bob'),
      id: sfs.int(70_001),
    }),
  ],
  [
    '>',
    packet(0, 4, {
      r: sfs.int(3),
      p: sfs.string('room-pass'),
    }),
  ],
  [
    '<',
    extensionPacket('updateCurrentCashOuts', {
      code: sfs.int(200),
    }, { compress: true }),
  ],
  [
    '>',
    packet(0, 29, {}),
  ],
  [
    '<',
    packet(0, 1000, {
      u: sfs.array([]),
    }),
  ],
  [
    '<',
    packet(0, 777, {}),
  ],
  [
    '<',
    packet(2, 5, {}),
  ],
])
const BLUEBOX = { path: '/BlueBox/websocket', query: [], subprotocols: [] }
const PLAIN = { path: '/ws', query: [], subprotocols: [] }

describe('sfs2x decoder', () => {
  it('names system actions from the published table and extensions by their command', () => {
    expect(readAll(sfs2x, session)).toEqual([
      ['system Handshake'],
      ['system Handshake'],
      ['system Login'],
      ['system Login'],
      ['system JoinRoom'],
      ['extension updateCurrentCashOuts'],
      ['system PingPong'],
      ['system UserEnterRoom'],
      ['system action 777'],
      ['controller 2 action 5'],
    ])
  })

  it('gives client requests their roles and the extension params as payload', () => {
    const reader = sfs2x.start()
    const read = session.map(frame => reader.read(frame)?.[0])
    expect(read.map(item => item?.role)).toEqual([
      'init',
      'data',
      'auth',
      'data',
      'subscribe',
      'data',
      'keepalive',
      'data',
      'data',
      'data',
    ])
    expect(read[5]?.payload).toEqual({ code: 200 })
    expect(read[5]?.wire).toBe('SFS2X {c:1,a:13,p:{c:"{0}",p:<payload>}}')
    expect(read[0]?.wire).toBe('SFS2X {c:0,a:0,p:<payload>}')
    expect(reader.version()).toBe('client API 1.8.4')
  })

  it('names the session token, the password, user names and a room password as secrets', () => {
    const reader = sfs2x.start()
    const secrets = session.flatMap(frame => reader.read(frame)?.flatMap(item => item.secrets) ?? [])
    expect(secrets).toEqual([
      '0123456789abcdef0123456789abcdef',
      'hunter2',
      'bob',
      'bob',
      'room-pass',
    ])
  })

  it('counts encrypted packets without decoding them', () => {
    const reader = sfs2x.start()
    const [item] = binaryFrames([
      [
        '<',
        rawPacket([9, 9, 9], { flags: 0x40 }),
      ],
    ]).flatMap(frame => reader.read(frame) ?? [])
    expect(item).toMatchObject({
      frame: 'encrypted',
      name: ['encrypted'],
      payload: undefined,
      strong: false,
    })
  })

  it('leaves text frames and other binary alone', () => {
    const reader = sfs2x.start()
    expect(reader.read({ direction: 'received', data: '{"a":1}', binary: false })).toBeNull()
    expect(reader.read({
      direction: 'received',
      data: base64(Uint8Array.from([0x82, 0xA1, 0x61])),
      binary: true,
    })).toBeNull()
    expect(reader.read({ direction: 'received', data: 'not base64!', binary: true })).toBeNull()
  })

  it('takes the hint from a BlueBox or sfs URL path only', () => {
    expect(sfs2x.hint(BLUEBOX)).toBe('URL path contains /BlueBox/')
    expect(sfs2x.hint({ ...PLAIN, path: '/sfs2x/websocket' })).toBe('URL path has an sfs segment')
    expect(sfs2x.hint(PLAIN)).toBeNull()
    expect(sfs2x.hint({ ...PLAIN, path: '/offsfs' })).toBeNull()
  })
})

describe('sfs2x detection', () => {
  it('detects the protocol from the BlueBox path and from the frames alone', () => {
    expect(decodeConnection(session, BLUEBOX).protocol).toEqual({
      id: 'sfs2x',
      version: 'client API 1.8.4',
      evidence: ['URL path contains /BlueBox/', 'frames'],
      wrapper: null,
    })
    expect(decodeConnection(session, PLAIN).protocol?.evidence).toEqual(['frames'])
  })

  it('needs most binary frames to decode without a hint, and a decoded packet besides encrypted ones', () => {
    const noise = binaryFrames([
      [
        '<',
        Uint8Array.from([1, 2, 3]),
      ],
      [
        '<',
        Uint8Array.from([4, 5, 6]),
      ],
    ])
    expect(decodeConnection([
      ...binaryFrames([
        ['<', handshakeReply],
      ]),
      ...noise,
    ], PLAIN).protocol).toBeNull()
    const encrypted = binaryFrames([
      [
        '<',
        rawPacket([1, 2], { flags: 0x40 }),
      ],
    ])
    expect(decodeConnection(encrypted, PLAIN).protocol).toBeNull()
    expect(decodeConnection(encrypted, BLUEBOX).protocol?.id).toBe('sfs2x')
  })

  it('does not take a text protocol\'s connection', () => {
    const text: RawFrame[] = [
      { direction: 'received', data: '0{"sid":"abc","upgrades":[],"pingInterval":25000}', binary: false },
      ...binaryFrames([
        ['<', handshakeReply],
      ]),
    ]
    expect(decodeConnection(text, { ...PLAIN, path: '/socket.io/' }).protocol?.id).toBe('socket.io')
  })
})
