import { describe, expect, it } from 'vitest'
import { pollingPackets, socketIo } from './socketio'
import { rawFrames, readAll } from './test-frames'

describe('socketIo decoder', () => {
  it('reads Engine.IO and Socket.IO v4 packets, naming events and the acks that answer them', () => {
    const frames = rawFrames([
      ['<', '0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000}'],
      ['>', '40{"token":"t0k3n"}'],
      ['<', '40{"sid":"def"}'],
      ['>', '421["join room",{"room":"lobby"}]'],
      ['<', '431[{"ok":true}]'],
      ['<', '42["chat message","hi",3]'],
      ['<', '2'],
      ['>', '3'],
      ['>', '42/admin,["stats"]'],
      ['>', '41'],
    ])
    expect(readAll(socketIo, frames)).toEqual([
      ['open open'],
      ['connect connect'],
      ['connect connect'],
      ['event join room'],
      ['ack join room'],
      ['event chat message'],
      ['ping ping'],
      ['pong pong'],
      ['event /admin stats'],
      ['disconnect disconnect'],
    ])
    const session = socketIo.start()
    const decoded = frames.map(frame => session.read(frame)?.[0])
    expect(session.version()).toBe('Engine.IO 4')
    expect(decoded[1]).toMatchObject({
      role: 'auth',
      payload: { token: 't0k3n' },
      wire: '40<payload>',
    })
    expect(decoded[3]).toMatchObject({
      payload: { room: 'lobby' },
      wire: '42<ackId>["{0}",<payload>]',
    })
    expect(decoded[5]?.payload).toEqual(['hi', 3])
    expect(decoded[8]).toMatchObject({
      name: ['/admin', 'stats'],
      wire: '42{0},["{1}"]',
      payload: undefined,
    })
  })

  it('attributes binary attachments to the event that announced them', () => {
    const session = socketIo.start()
    const first = session.read({ direction: 'sent', data: '451-["upload",{"_placeholder":true,"num":0}]', binary: false })
    const attachment = session.read({ direction: 'sent', data: 'AQID', binary: true })
    const stray = session.read({ direction: 'sent', data: 'AQID', binary: true })
    expect(first?.[0]).toMatchObject({
      frame: 'binary event',
      name: ['upload'],
      wire: '451-["{0}",<payload>]',
    })
    expect(attachment?.[0]).toMatchObject({
      frame: 'attachment',
      name: ['upload'],
      binary: true,
    })
    expect(stray).toBeNull()
  })

  it('tells Engine.IO 3 by the client pinging', () => {
    const session = socketIo.start()
    session.read({ direction: 'sent', data: '2', binary: false })
    expect(session.version()).toBe('Engine.IO 3')
  })

  it('rejects text that only starts with a digit', () => {
    expect(readAll(socketIo, rawFrames([
      ['<', '42'],
      ['<', '42{"a":1}'],
      ['<', '0{"no":"sid"}'],
      ['<', '7'],
      ['<', '12345'],
      ['<', '{"type":"x"}'],
    ]))).toEqual([null, null, null, null, null, null])
  })

  it('takes hints from the path and the EIO query', () => {
    expect(socketIo.hint({ path: '/socket.io/', query: [], subprotocols: [] })).toBe('URL path /socket.io/')
    expect(socketIo.hint({
      path: '/ws',
      query: [
        { name: 'EIO', value: '4' },
      ],
      subprotocols: [],
    })).toBe('query EIO=4')
    expect(socketIo.handshakeVersion({
      path: '/ws',
      query: [
        { name: 'EIO', value: '3' },
      ],
      subprotocols: [],
    })).toBe('Engine.IO 3')
    expect(socketIo.hint({ path: '/ws', query: [], subprotocols: [] })).toBeNull()
  })
})

describe('pollingPackets', () => {
  it('splits v4 bodies on the record separator and reads b-prefixed binary', () => {
    expect(pollingPackets('40{"token":"x"}\x1E42["hi"]\x1EbAQID', '4')).toEqual([
      { data: '40{"token":"x"}', binary: false },
      { data: '42["hi"]', binary: false },
      { data: 'AQID', binary: true },
    ])
  })

  it('reads v3 length-prefixed bodies', () => {
    expect(pollingPackets('8:42["hi"]2:40', '3')).toEqual([
      { data: '42["hi"]', binary: false },
      { data: '40', binary: false },
    ])
    expect(pollingPackets('x:42', '3')).toEqual([])
  })
})
