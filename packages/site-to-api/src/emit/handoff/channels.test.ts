import { describe, expect, it } from 'vitest'
import { channelMessage, socketIoChannel, tickerChannel } from '../../../test/channels'
import { channelFormatLabel, channelsSection, channelsSummary } from './channels'

const binaryChannel = tickerChannel({
  id: 'wsBlueBox',
  host: 'app-demo.spribegaming.com',
  scheme: 'wss',
  path: '/BlueBox/websocket',
  messages: [
    channelMessage({ id: 'send-binary', direction: 'send', format: 'binary' }),
    channelMessage({ id: 'receive-binary', direction: 'receive', format: 'binary' }),
  ],
})

describe('channelFormatLabel', () => {
  it('says binary for a channel of binary frames, as the host file lists them', () => {
    expect(channelFormatLabel(binaryChannel)).toBe('binary')
  })

  it('keeps JSON / text for plain channels and lists every format of a mixed one', () => {
    expect(channelFormatLabel(tickerChannel({
      messages: [
        channelMessage({ id: 'subscribe', direction: 'send' }),
        channelMessage({ id: 'tick', direction: 'receive' }),
        channelMessage({ id: 'text', direction: 'receive', format: 'text' }),
      ],
    }))).toBe('JSON / text')
    expect(channelFormatLabel(tickerChannel())).toBe('JSON / text / binary')
    expect(channelFormatLabel(tickerChannel({
      messages: [
        channelMessage({ id: 'a', direction: 'send', format: 'json' }),
        channelMessage({ id: 'b', direction: 'receive', format: 'msgpack' }),
        channelMessage({ id: 'c', direction: 'receive', format: 'binary' }),
      ],
    }))).toBe('JSON / MessagePack / binary')
  })

  it('names the framing protocol when one was recognised', () => {
    expect(channelFormatLabel(socketIoChannel())).toBe('Socket.IO')
  })
})

describe('channelsSummary', () => {
  it('labels a binary channel binary in AGENT.md', () => {
    const lines = channelsSummary([binaryChannel], host => `hosts/${host}.md`)
    const line = lines.find(entry => entry.includes('BlueBox')) ?? ''
    expect(line).toContain('binary')
    expect(line).not.toContain('JSON / text')
  })
})

describe('channelsSection for a server-sent event stream', () => {
  it('says how to open the stream instead of describing a WebSocket upgrade', () => {
    const stream = tickerChannel({
      id: 'v2StreamRecentchange',
      host: 'stream.example.test',
      scheme: 'https',
      path: '/v2/stream/recentchange',
      handshake: [],
      cookies: { status: 'none', names: [] },
      protocol: {
        id: 'sse',
        version: null,
        evidence: ['response type text/event-stream', 'frames'],
        wrapper: null,
      },
      messages: [
        channelMessage({
          id: 'receiveMessage',
          direction: 'receive',
          protocol: {
            protocol: 'sse',
            frame: 'event',
            name: 'message',
            role: 'data',
            wire: 'event: {0}\ndata: <payload>',
          },
        }),
      ],
      connection: {
        origins: [],
        subprotocols: { requested: [], selected: [] },
        urlTokens: [],
        upgrade: {
          accepted: 1,
          rejected: 0,
          unknown: 0,
          statuses: [200],
        },
        firstMessage: null,
        transports: ['sse'],
      },
    })
    const text = channelsSection([stream], new Map()).join('\n')
    expect(text).toContain('### `https://stream.example.test/v2/stream/recentchange`')
    expect(text).toContain('- Stream request: a `GET` the server answers with `text/event-stream`')
    expect(text).toContain('the server accepted 1 of 1 stream (status 200)')
    expect(text).toContain('`Last-Event-ID`')
    expect(text).toContain('Protocol: server-sent events, shown by response type text/event-stream, frames.')
    expect(text).not.toContain('Upgrade request')
    expect(channelFormatLabel(stream)).toBe('server-sent events')
  })
})
