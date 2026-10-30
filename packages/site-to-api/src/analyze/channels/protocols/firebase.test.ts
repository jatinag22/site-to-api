import { describe, expect, it } from 'vitest'
import { firebase } from './firebase'
import { decodeConnection } from './index'
import { rawFrames, readAll } from './test-frames'

const HINTED = {
  path: '/.ws',
  query: [
    { name: 'v', value: '5' },
    { name: 'ns', value: 'demo-board' },
  ],
  subprotocols: [],
}
const PLAIN = { path: '/feed', query: [], subprotocols: [] }

const session = rawFrames([
  ['<', '{"t":"c","d":{"t":"h","d":{"ts":1700000000000,"v":"5","h":"demo-board.example","s":"sess-abc"}}}'],
  ['>', '{"t":"d","d":{"r":1,"a":"s","b":{"c":{"sdk.js.9-9-9":1}}}}'],
  ['>', '{"t":"d","d":{"r":2,"a":"auth","b":{"cred":"invented-token-1234567890"}}}'],
  ['<', '{"t":"d","d":{"r":2,"b":{"s":"ok","d":{"auth":null}}}}'],
  ['>', '{"t":"d","d":{"r":3,"a":"q","b":{"p":"/v0/item/41001","h":""}}}'],
  ['<', '{"t":"d","d":{"a":"d","b":{"p":"v0/item/41001","d":{"title":"Invented story","score":7}}}}'],
  ['<', '{"t":"d","d":{"r":3,"b":{"s":"ok","d":{}}}}'],
  ['>', '{"t":"d","d":{"r":4,"a":"n","b":{"p":"/v0/item/41001"}}}'],
  ['<', '{"t":"d","d":{"r":4,"b":{"s":"permission_denied","d":"Permission denied"}}}'],
  ['>', '{"t":"c","d":{"t":"p","d":{}}}'],
  ['<', '{"t":"c","d":{"t":"o","d":null}}'],
])

describe('firebase decoder', () => {
  it('names requests by action and path, pushes by path and answers after their request', () => {
    expect(readAll(firebase, session)).toEqual([
      ['hello hello'],
      ['stats stats'],
      ['auth auth'],
      ['response auth'],
      ['listen listen /v0/item/41001'],
      ['data data v0/item/41001'],
      ['response listen /v0/item/41001'],
      ['unlisten unlisten /v0/item/41001'],
      ['error unlisten /v0/item/41001'],
      ['ping ping'],
      ['pong pong'],
    ])
  })

  it('gives roles, payloads, the auth credential as a protocol secret and the version', () => {
    const reader = firebase.start()
    const read = session.map(frame => reader.read(frame)?.[0])
    expect(read.map(item => item?.role)).toEqual([
      'init',
      'data',
      'auth',
      'data',
      'subscribe',
      'data',
      'data',
      'unsubscribe',
      'data',
      'keepalive',
      'keepalive',
    ])
    expect(read[2]?.secrets).toEqual(['invented-token-1234567890'])
    expect(read[4]).toMatchObject({
      payload: { p: '/v0/item/41001', h: '' },
      wire: '{"t":"d","d":{"r":<request>,"a":"q","b":<payload>}}',
    })
    expect(read[5]?.payload).toEqual({ title: 'Invented story', score: 7 })
    expect(reader.version()).toBe('v5')
  })

  it('reassembles a split message and writes no piece on its own', () => {
    const reader = firebase.start()
    const pieces = rawFrames([
      ['<', '2'],
      ['<', '{"t":"d","d":{"a":"d","b":{"p":"/v0/top'],
      ['<', 'stories","d":[1,2,3]}}}'],
    ])
    const read = pieces.map(frame => reader.read(frame)?.map(item => `${item.frame} ${item.name.join(' ')}`))
    expect(read).toEqual([
      [],
      [],
      ['data data /v0/topstories'],
    ])
    // Pieces that make no Firebase message are dropped too, never shown as the last piece.
    const broken = rawFrames([
      ['<', '2'],
      ['<', '{"secretKey":"'],
      ['<', 'invented-piece-value"}'],
    ])
    const fresh = firebase.start()
    expect(broken.map(frame => fresh.read(frame))).toEqual([[], [], []])
  })

  it('names the hello session id and the reconnect `ls` as secrets', () => {
    const reader = firebase.start({
      ...HINTED,
      query: [
        ...HINTED.query,
        { name: 'ls', value: 'invented-last-session' },
      ],
    })
    const [hello] = reader.read(session[0] ?? { direction: 'received', data: '', binary: false }) ?? []
    expect(hello?.secrets).toEqual(['sess-abc', 'invented-last-session'])
  })

  it('rejects frames that break the protocol and bounds fragments', () => {
    const reader = firebase.start()
    const bad = rawFrames([
      ['>', '{"t":"d","d":{"r":1,"a":"zz","b":{}}}'],
      ['>', '{"t":"d","d":{"a":"q","b":{"p":"/x"}}}'],
      ['>', '{"t":"x","d":{}}'],
      ['>', '{"t":"d","d":{"r":1,"a":"q","b":{}},"extra":1}'],
      ['<', '{"t":"d","d":{"a":"zz","b":{}}}'],
      ['<', '0'],
      ['<', '99999'],
      ['>', 'not json'],
    ])
    expect(bad.map(frame => reader.read(frame))).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
  })

  it('is detected from the /.ws URL or from its frames', () => {
    expect(decodeConnection(session, HINTED).protocol).toMatchObject({
      id: 'firebase',
      version: 'v5',
      evidence: ['URL path /.ws with ns and v query parameters', 'frames'],
    })
    expect(decodeConnection(session, PLAIN).protocol?.id).toBe('firebase')
    // A JSON feed with `t` and `d` fields but nothing Firebase-only is not taken.
    const lookalike = rawFrames([
      ['<', '{"t":"d","d":{"price":1}}'],
      ['<', '{"t":"d","d":{"price":2}}'],
    ])
    expect(decodeConnection(lookalike, PLAIN).protocol).toBeNull()
  })
})
