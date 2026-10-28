import { describe, expect, it } from 'vitest'
import { compactHar } from './har'

function entry(resourceType: string, mimeType: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _resourceType: resourceType,
    request: { method: 'GET', url: `https://shop.test/${resourceType}` },
    response: {
      status: 200,
      headers: [],
      content: {
        size: text.length,
        mimeType,
        text,
        encoding: 'base64',
      },
    },
    ...extra,
  }
}

describe('compactHar', () => {
  it('drops asset bodies and WebSocket frames, keeping what build reads', () => {
    const har = {
      log: {
        entries: [
          entry('image', 'image/avif', 'AAAA'),
          entry('script', 'application/javascript', 'var a=1'),
          entry('stylesheet', 'text/css', 'a{}'),
          entry('document', 'text/html', '<html></html>'),
          entry('fetch', 'application/json', '{"a":1}'),
          // Video over XHR: classify reads its media type, so the body stays.
          entry('xhr', 'video/MP2T', 'AAAA'),
          entry('websocket', 'x-unknown', '', {
            _webSocketMessages: [
              { type: 'send', opcode: 1, data: '{}' },
              { type: 'receive', opcode: 1, data: '{}' },
            ],
          }),
        ],
      },
    }
    expect(compactHar(har)).toEqual({ entries: 7, bodiesOmitted: 3, framesOmitted: 2 })
    const contents = har.log.entries.map(item => (item.response as { content: Record<string, unknown> }).content)
    expect(contents[0]).toEqual({ size: 4, mimeType: 'image/avif', comment: 'body omitted by site-to-api: asset' })
    expect(contents[3]?.text).toBe('<html></html>')
    expect(contents[4]?.text).toBe('{"a":1}')
    expect(contents[5]?.text).toBe('AAAA')
    expect(har.log.entries[6]).not.toHaveProperty('_webSocketMessages')
  })

  it('leaves entries without a body or of unknown shape alone', () => {
    const har = {
      log: {
        entries: [
          entry('image', 'image/png', ''),
          'odd',
          { _resourceType: 'font' },
        ],
      },
    }
    expect(compactHar(har)).toEqual({ entries: 3, bodiesOmitted: 0, framesOmitted: 0 })
  })
})
