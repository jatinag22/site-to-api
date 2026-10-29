import { describe, expect, it } from 'vitest'
import { signalr } from './signalr'
import { rawFrames, readAll } from './test-frames'

const RS = '\x1E'

describe('signalr decoder', () => {
  it('reads the handshake, invocations, completions named after their call, and pings', () => {
    const frames = rawFrames([
      ['>', `{"protocol":"json","version":1}${RS}`],
      ['<', `{}${RS}`],
      ['>', `{"type":1,"invocationId":"0","target":"JoinGroup","arguments":["odds"]}${RS}`],
      ['<', `{"type":3,"invocationId":"0","result":true}${RS}{"type":1,"target":"OddsChanged","arguments":[{"id":7,"price":1.9}]}${RS}`],
      ['<', `{"type":6}${RS}`],
      ['>', `{"type":7}${RS}`],
    ])
    expect(readAll(signalr, frames)).toEqual([
      ['handshake handshake'],
      ['handshake response handshake response'],
      ['invocation JoinGroup'],
      ['completion JoinGroup completion', 'invocation OddsChanged'],
      ['ping ping'],
      ['close close'],
    ])
    const session = signalr.start()
    const decoded = frames.flatMap(frame => session.read(frame) ?? [])
    expect(session.version()).toBe('json 1')
    expect(decoded[2]).toMatchObject({ payload: 'odds', wire: '{"type":1,"invocationId":"<id>","target":"{0}","arguments":<payload>}\\x1e' })
    expect(decoded[4]).toMatchObject({
      payload: { id: 7, price: 1.9 },
      data: `{"type":1,"target":"OddsChanged","arguments":[{"id":7,"price":1.9}]}${RS}`,
    })
  })

  it('needs the record separator and a known message type', () => {
    expect(readAll(signalr, rawFrames([
      ['<', '{"type":1,"target":"x","arguments":[]}'],
      ['<', `{"type":42}${RS}`],
      ['<', `{"type":1,"target":"x"}${RS}`],
    ]))).toEqual([null, null, null])
  })
})
