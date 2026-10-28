import type { ResolvedConfig } from '../../config/schema'
import type { CaptureEvent, Exchange, LoadedSession, WebSocketChannel } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, jsonBody, loadedSession, socketEvents, textBody } from '../../../test/helpers'
import { fakeHtmlLocator, fakeSourceResolver } from '../../../test/scenarios'
import { classifyExchanges, createChannelScope } from '../classify'
import { traceValues } from '../correlate'
import { buildOperations } from '../operations'
import { createRedactor } from '../redact'
import { inferOperationSchemas } from '../schema'
import { buildChannels, channelExchanges, collectConnections } from './index'

const HOST = 'shop.test'
const REDACT: ResolvedConfig['redact'] = {
  examples: 'masked',
  maxExamples: 3,
  patterns: [],
  fields: [],
}
const T0 = 1_700_000_000_000

/** Runs the stages the way `build` does and returns the channels. */
function channelsOf(exchanges: Exchange[], sessions: LoadedSession[], hosts: ResolvedConfig['hosts'] = { include: [], exclude: [] }): WebSocketChannel[] {
  const classified = classifyExchanges(exchanges, hosts)
  const sockets = channelExchanges(collectConnections(sessions))
  const redactor = createRedactor({
    exchanges: [
      ...classified.exchanges,
      ...sockets.exchanges,
    ],
    config: REDACT,
  })
  const operations = inferOperationSchemas(buildOperations(classified.exchanges, { sourceRoutes: [] }), redactor)
  const traces = traceValues({
    exchanges: [
      ...classified.exchanges,
      ...sockets.exchanges,
    ],
    sessions,
    htmlLocator: fakeHtmlLocator,
    staticStrings: new Set(),
    minValueLength: 4,
  })
  return buildChannels({
    channelExchanges: sockets,
    exchanges: classified.exchanges,
    operations,
    traces,
    redactor,
    sourceRoutes: [],
    sourceResolver: fakeSourceResolver,
    inScope: createChannelScope(classified.exchanges, hosts),
  })
}

function page(sessionId: string, path: string, at: number): Exchange {
  return exchange({
    sessionId,
    url: `https://${HOST}${path}`,
    resourceType: 'document',
    startedAt: T0 + at,
    responseBody: textBody('<html><body>shop</body></html>'),
  })
}

function upgrade(sessionId: string, url: string, at: number, cookies: Record<string, string>, stack = false): Exchange {
  const base = exchange({
    sessionId,
    url,
    resourceType: 'websocket',
    startedAt: T0 + at,
    cookies,
    status: 101,
  })
  return stack
    ? {
        ...base,
        initiator: {
          via: 'other',
          stack: [
            {
              url: `https://${HOST}/app.js`,
              line: 3,
              column: 9,
              functionName: 'connectTicker',
            },
          ],
        },
      }
    : base
}

/** The ticker of the fixture shop: a product list, then a subscription with an id from it. */
function tickerCapture(sessionId: string, productId: number, options: { upgrade?: 'cookies' | 'none' | 'missing' } = {}): { exchanges: Exchange[], session: LoadedSession } {
  const url = `wss://${HOST}/ws/ticker`
  const exchanges = [
    page(sessionId, '/', 0),
    exchange({
      sessionId,
      url: `https://${HOST}/api/products`,
      startedAt: T0 + 100,
      responseBody: jsonBody({
        items: [
          { id: productId, name: 'Peanuts' },
        ],
      }),
    }),
  ]
  if (options.upgrade !== 'missing') {
    exchanges.push(upgrade(sessionId, url, 1_000, options.upgrade === 'none'
      ? {}
      : { sid: `secret-session-${sessionId}` }, true))
  }
  const events: CaptureEvent[] = socketEvents({
    url,
    pageUrl: `https://${HOST}/products/${productId}`,
    socket: 0,
    openedAt: T0 + 1_000,
    frames: [
      ['<', '{"type":"hello","channel":"prices"}'],
      ['>', `{"type":"subscribe","productId":${productId}}`],
      ['<', `{"type":"tick","productId":${productId},"seq":1,"price":10.5}`],
      ['<', `{"type":"tick","productId":${productId},"seq":2,"price":11}`],
      ['>', '{"type":"ping"}'],
    ],
  })
  return {
    exchanges,
    session: loadedSession(sessionId, events),
  }
}

function twoSessions(options: Parameters<typeof tickerCapture>[2] = {}): WebSocketChannel[] {
  const a = tickerCapture('a', 1007, options)
  const b = tickerCapture('b', 1014, options)
  return channelsOf([
    ...a.exchanges,
    ...b.exchanges,
  ], [a.session, b.session])
}

describe('buildChannels', () => {
  it('describes the ticker: URL, messages per direction, handshake and connection count', () => {
    const [channel, ...rest] = twoSessions()
    expect(rest).toEqual([])
    expect(channel).toMatchObject({
      id: 'wsTicker',
      host: HOST,
      scheme: 'wss',
      path: '/ws/ticker',
      connections: 2,
      summary: 'WebSocket ws ticker: the client sends subscribe, ping; the server sends hello, tick.',
    })
    expect(channel!.messages.map(message => `${message.direction}:${message.id}:${message.count}`)).toEqual([
      'send:sendSubscribe:2',
      'send:sendPing:2',
      'receive:receiveHello:2',
      'receive:receiveTick:4',
    ])
    // The server's greeting comes first; the handshake is what the client sends before the next answer.
    expect(channel!.handshake).toEqual([
      {
        message: 'sendSubscribe',
        example: { type: 'subscribe', productId: 1007 },
      },
    ])
  })

  it('links the subscribed id to the operation whose response listed it', () => {
    const [channel] = twoSessions()
    const subscribe = channel!.messages.find(message => message.id === 'sendSubscribe')
    expect(subscribe?.links).toEqual([
      {
        input: 'body./productId',
        origin: {
          kind: 'response',
          operationId: 'getApiProducts',
          host: HOST,
          output: 'body./items/0/id',
          transform: 'none',
        },
        samples: 2,
      },
    ])
    expect(channel!.messages.find(message => message.id === 'sendPing')?.links).toEqual([])
  })

  it('reports cookie names from the upgrade request, never values, and the code that opened it', () => {
    const [channel] = twoSessions()
    expect(channel!.cookies).toEqual({
      status: 'sent',
      names: ['sid'],
    })
    expect(JSON.stringify(channel)).not.toContain('secret-session')
    expect(channel!.sentFrom).toMatchObject({ file: 'src/connectTicker.ts', functionName: 'connectTicker' })
  })

  it('says none when the upgrade had no cookies and unknown when the HAR lacks it', () => {
    expect(twoSessions({ upgrade: 'none' })[0]!.cookies).toEqual({ status: 'none', names: [] })
    const [missing] = twoSessions({ upgrade: 'missing' })
    expect(missing!.cookies).toEqual({ status: 'unknown', names: [] })
    expect(missing!.sentFrom).toBeNull()
  })

  it('templates the connection path and infers query parameters like an HTTP request', () => {
    const sessions = ['8842', '1931', '5507'].map((room, index) => loadedSession(`s${index}`, socketEvents({
      url: `wss://${HOST}/rooms/${room}/socket?lang=en&v=${index + 1}`,
      pageUrl: `https://${HOST}/`,
      socket: 0,
      frames: [
        ['<', '{"event":"joined"}'],
      ],
    })))
    const [channel] = channelsOf([
      page('s0', '/', 0),
      page('s1', '/', 0),
      page('s2', '/', 0),
    ], sessions)
    expect(channel!.path).toBe('/rooms/{roomId}/socket')
    expect(channel!.id).toBe('roomsByRoomIdSocket')
    expect(channel!.pathParams.map(param => param.name)).toEqual(['roomId'])
    expect(channel!.query.map(param => [param.name, param.required])).toEqual([
      ['lang', true],
      ['v', true],
    ])
    expect(channel!.handshake).toEqual([])
    expect(channel!.summary).toBe('WebSocket rooms by room id socket: the client sends nothing; the server sends joined.')
  })

  it('links connection URL values to their producer', () => {
    const exchanges = [
      page('s1', '/', 0),
      exchange({
        sessionId: 's1',
        url: `https://${HOST}/api/rooms`,
        startedAt: T0 + 100,
        responseBody: jsonBody({ room: 'lobby-4471' }),
      }),
    ]
    const session = loadedSession('s1', socketEvents({
      url: `wss://${HOST}/socket?room=lobby-4471`,
      pageUrl: `https://${HOST}/`,
      openedAt: T0 + 500,
      frames: [],
    }))
    const [channel] = channelsOf(exchanges, [session])
    expect(channel!.links).toEqual([
      {
        input: 'query.room',
        origin: {
          kind: 'response',
          operationId: 'getApiRooms',
          host: HOST,
          output: 'body./room',
          transform: 'none',
        },
        samples: 1,
      },
    ])
  })

  it('leaves out an HTML origin that names no place in the page', () => {
    // The page contains the value, but nowhere an extraction rule can read it from.
    const exchanges = [
      exchange({
        sessionId: 's1',
        url: `https://${HOST}/`,
        resourceType: 'document',
        startedAt: T0,
        responseBody: textBody('<html><body><script>window.r="rk_7Hq2x9Lm4Pz"</script></body></html>'),
      }),
    ]
    const session = loadedSession('s1', socketEvents({
      url: `wss://${HOST}/socket`,
      pageUrl: `https://${HOST}/`,
      openedAt: T0 + 500,
      frames: [
        ['>', '{"type":"join","room":"rk_7Hq2x9Lm4Pz"}'],
      ],
    }))
    const [channel] = channelsOf(exchanges, [session])
    expect(channel!.messages.find(message => message.id === 'sendJoin')?.links).toEqual([])
  })

  it('leaves out an HTML origin for a value sent inside a longer string', () => {
    const exchanges = [
      exchange({
        sessionId: 's1',
        url: `https://${HOST}/`,
        resourceType: 'document',
        startedAt: T0,
        responseBody: textBody('<html><head><meta name="ws-key" content="wk_7Hq2x9Lm4Pz"></head></html>'),
      }),
    ]
    const session = loadedSession('s1', socketEvents({
      url: `wss://${HOST}/socket`,
      pageUrl: `https://${HOST}/`,
      openedAt: T0 + 500,
      frames: [
        ['>', '{"type":"auth","key":"wk_7Hq2x9Lm4Pz","header":"Key wk_7Hq2x9Lm4Pz"}'],
      ],
    }))
    const [channel] = channelsOf(exchanges, [session])
    expect(channel!.messages.find(message => message.id === 'sendAuth')?.links.map(link => link.input)).toEqual(['body./key'])
  })

  it('leaves out sockets to analytics hosts, excluded hosts and pages of hosts not analysed', () => {
    const sessions = [
      loadedSession('s1', [
        ...socketEvents({
          url: 'wss://www.google-analytics.com/socket',
          pageUrl: `https://${HOST}/`,
          frames: [
            ['<', 'x'],
          ],
        }),
        ...socketEvents({
          url: 'wss://rt.shop.test/live',
          pageUrl: `https://${HOST}/`,
          socket: 1,
          frames: [
            ['<', '{"type":"a"}'],
          ],
        }),
        ...socketEvents({
          url: 'wss://chat.elsewhere.test/live',
          pageUrl: 'https://elsewhere.test/',
          socket: 2,
          frames: [
            ['<', '{"type":"b"}'],
          ],
        }),
      ]),
    ]
    const exchanges = [
      page('s1', '/', 0),
    ]
    expect(channelsOf(exchanges, sessions).map(channel => channel.host)).toEqual(['rt.shop.test'])
    expect(channelsOf(exchanges, sessions, {
      include: [],
      exclude: ['rt.shop.test'],
    })).toEqual([])
    expect(channelsOf(exchanges, sessions, {
      include: ['chat.elsewhere.test'],
      exclude: [],
    }).map(channel => channel.host)).toEqual(['chat.elsewhere.test'])
  })

  it('returns the same channels for the same input', () => {
    expect(JSON.stringify(twoSessions())).toBe(JSON.stringify(twoSessions()))
  })

  it('returns nothing without WebSocket events', () => {
    expect(channelsOf([
      page('s1', '/', 0),
    ], [
      loadedSession('s1', []),
    ])).toEqual([])
  })
})
