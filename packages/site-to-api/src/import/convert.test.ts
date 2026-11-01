import { describe, expect, it } from 'vitest'
import { chromeHar, firefoxHar, harEntry, safariHar } from '../../test/har-fixtures'
import { convertHar } from './convert'
import { ImportHarSchema } from './har-input'

function convert(har: Record<string, unknown>): ReturnType<typeof convertHar> {
  return convertHar(ImportHarSchema.parse(har))
}

describe('convertHar: Chrome', () => {
  const result = convert(chromeHar())

  it('keeps every entry, takes the WebSocket frames out of the HAR and starts at the page load', () => {
    expect(result.entries).toHaveLength(6)
    expect(result.entries.some(entry => '_webSocketMessages' in entry)).toBe(false)
    expect(result.startUrl).toBe('https://shop.test/')
    expect(result.userAgent).toBe('Mozilla/5.0 (Test) Browser/1.0')
    expect(result.warnings).toEqual([])
  })

  it('names the navigation after the page title', () => {
    expect(result.events.filter(event => event.t === 'action')).toEqual([
      {
        t: 'action',
        kind: 'navigate',
        ts: Date.parse('2026-01-01T10:00:00.000Z'),
        pageUrl: 'https://shop.test/',
        label: 'Shop - Home',
        selector: '',
        field: null,
      },
    ])
  })

  it('turns script initiators into request events with 1-based frames, async parents included', () => {
    const requests = result.events.filter(event => event.t === 'request')
    expect(result.stacks).toBe(2)
    expect(requests[0]).toMatchObject({
      via: 'fetch',
      method: 'GET',
      url: 'https://shop.test/api/items',
      pageUrl: 'https://shop.test/',
    })
    expect(requests[0]?.t === 'request' && requests[0].stack).toEqual([
      {
        url: 'https://shop.test/static/app.js',
        line: 1,
        column: 42,
        functionName: 'loadItems',
      },
      {
        url: 'https://shop.test/static/app.js',
        line: 2,
        column: 4,
        functionName: 'boot',
      },
    ])
    expect(requests[1]).toMatchObject({ via: 'xhr', method: 'POST', bodyPreview: '{"q":"nuts"}' })
  })

  it('turns _webSocketMessages into ws events, binary frames marked', () => {
    const frames = result.events.filter(event => event.t === 'ws')
    expect(frames.map(event => event.t === 'ws' && [event.direction, event.binary ?? false, event.socket])).toEqual([
      ['open', false, 0],
      ['sent', false, 0],
      ['received', false, 0],
      ['received', true, 0],
    ])
    expect(frames[1]).toMatchObject({ url: 'wss://shop.test/ws/ticker', data: '{"type":"subscribe","productId":1042}', ts: 1767261601100 })
  })

  it('returns script bodies for source analysis, not images', () => {
    expect(result.scripts.map(script => script.url)).toEqual(['https://shop.test/static/app.js'])
  })
})

describe('convertHar: Firefox and Safari shapes', () => {
  it('reads Firefox pages titled by URL, base64 bodies and redirects, without _resourceType', () => {
    const result = convert(firefoxHar())
    expect(result.entries).toHaveLength(3)
    expect(result.events).toEqual([
      expect.objectContaining({ t: 'action', label: '/products', pageUrl: 'https://shop.test/products' }),
    ])
    expect(result.startUrl).toBe('https://shop.test/products')
    expect(result.stacks).toBe(0)
  })

  it('reads Safari exports without pages or cookie arrays, navigations from the page loads', () => {
    const result = convert(safariHar())
    expect(result.entries).toHaveLength(2)
    expect(result.events).toEqual([
      expect.objectContaining({
        t: 'action',
        kind: 'navigate',
        pageUrl: 'https://shop.test/cart',
        label: '/cart',
      }),
    ])
  })
})

describe('convertHar: untrusted entries', () => {
  it('drops entries that are not valid HAR with one counting warning, and ignores odd vendor fields', () => {
    const har = chromeHar()
    const log = har.log as { entries: unknown[] }
    log.entries.push('nonsense', { request: {} }, harEntry({ url: 'https://shop.test/x', started: 'not a date' }))
    const odd = harEntry({
      url: 'https://shop.test/api/odd',
      started: '2026-01-01T10:00:03.000Z',
      extra: {
        _initiator: {
          type: 'script',
          stack: { callFrames: 'nope' },
        },
        _webSocketMessages: 'nope',
      },
    })
    log.entries.push(odd)
    const result = convert(har)
    expect(result.warnings).toEqual([
      expect.stringMatching(/^Skipped 3 HAR entries that are not valid HAR \(first problem: /),
    ])
    // The odd entry is kept as traffic; its broken stack and frames are not read.
    expect(result.entries.some(entry => JSON.stringify(entry.request).includes('https://shop.test/api/odd'))).toBe(true)
    expect(result.events.some(event => 'url' in event && event.url === 'https://shop.test/api/odd')).toBe(false)
    expect(result.stacks).toBe(2)
  })
})

describe('convertHar: stored entries and warnings', () => {
  it('keeps only known fields and a bounded _initiator, so a 200,000-level chain still serialises', () => {
    let deep: Record<string, unknown> = { callFrames: [] }
    for (let i = 0; i < 200_000; i++) {
      deep = {
        callFrames: [
          { url: 'https://shop.test/a.js', lineNumber: i, columnNumber: 0 },
        ],
        parent: deep,
      }
    }
    const har = chromeHar()
    const log = har.log as { entries: unknown[] }
    log.entries.push(harEntry({
      url: 'https://shop.test/api/deep',
      started: '2026-01-01T10:00:04.000Z',
      extra: {
        pageref: 'page_1',
        _initiator: {
          type: 'script',
          stack: deep,
          _extra: { nested: deep },
        },
        _vendorBlob: { nested: deep },
      },
    }))
    const result = convert(har)
    const stored = result.entries.at(-1)
    expect(() => JSON.stringify(result.entries)).not.toThrow()
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      '_initiator',
      'pageref',
      'request',
      'response',
      'startedDateTime',
    ])
    let levels = 0
    let level: unknown = (stored?._initiator as { stack?: unknown }).stack
    while (typeof level === 'object' && level !== null) {
      levels++
      level = (level as { parent?: unknown }).parent
    }
    expect(levels).toBe(8)
    expect(result.events.find(event => event.t === 'request' && event.url === 'https://shop.test/api/deep')).toBeDefined()
  })

  it('skips data: and file: scripts instead of filing them under a made-up host', () => {
    const har = chromeHar()
    const log = har.log as { entries: unknown[] }
    for (const url of ['data:text/javascript,alert(1)', 'file:///home/someone/local.js']) {
      log.entries.push(harEntry({
        url,
        started: '2026-01-01T10:00:06.000Z',
        mimeType: 'application/javascript',
        text: 'void 0',
        extra: { _resourceType: 'script' },
      }))
    }
    expect(convert(har).scripts.map(script => script.url)).toEqual(['https://shop.test/static/app.js'])
  })
})
