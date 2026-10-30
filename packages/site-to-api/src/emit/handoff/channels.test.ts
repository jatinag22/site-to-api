import { describe, expect, it } from 'vitest'
import { channelMessage, socketIoChannel, tickerChannel } from '../../../test/channels'
import { channelFormatLabel, channelsSummary } from './channels'

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
