import type { ResolvedConfig } from '../../config/schema'
import type { Exchange, LoadedSession, WebSocketChannel } from '../../model'
import { describe, expect, it } from 'vitest'
import { exchange, loadedSession, socketEvents, textBody } from '../../../test/helpers'
import { fakeHtmlLocator, fakeSourceResolver } from '../../../test/scenarios'
import { channelsSection } from '../../emit/handoff/channels'
import { classifyExchanges, createChannelScope } from '../classify'
import { traceValues } from '../correlate'
import { buildOperations } from '../operations'
import { createRedactor } from '../redact'
import { inferOperationSchemas } from '../schema'
import { buildChannels, channelExchanges, collectConnections, isEnginePolling } from './index'

const HOST = 'live.test'
const T0 = 1_700_000_000_000
const REDACT: ResolvedConfig['redact'] = {
  examples: 'masked',
  maxExamples: 3,
  patterns: [],
  fields: [],
}
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTQyIn0.c2lnbmF0dXJlLXRoYXQtaXMtbG9uZw'

function channelsOf(input: Exchange[], sessions: LoadedSession[]): WebSocketChannel[] {
  // The page that opened the sockets: channels are kept for hosts the person browsed.
  const exchanges = [
    ...sessions.map(session => exchange({
      sessionId: session.meta.sessionId,
      url: `https://${HOST}/`,
      resourceType: 'document',
      startedAt: T0 - 500,
      responseBody: textBody('<html><body>live</body></html>'),
    })),
    ...input,
  ]
  const classified = classifyExchanges(exchanges, { include: [], exclude: [] })
  const http = classified.exchanges.map(item => isEnginePolling(item)
    ? { ...item, kind: 'noise' as const }
    : item)
  const sockets = channelExchanges(collectConnections(sessions, exchanges))
  const redactor = createRedactor({
    exchanges: [
      ...http,
      ...sockets.exchanges,
    ],
    config: REDACT,
  })
  const operations = inferOperationSchemas(buildOperations(http, { sourceRoutes: [], isSecretKey: redactor.isSecretKey }), redactor)
  const traces = traceValues({
    exchanges: [
      ...http,
      ...sockets.exchanges,
    ],
    sessions,
    htmlLocator: fakeHtmlLocator,
    staticStrings: new Set(),
    minValueLength: 4,
  })
  return buildChannels({
    channelExchanges: sockets,
    exchanges: http,
    operations,
    traces,
    redactor,
    sourceRoutes: [],
    sourceResolver: fakeSourceResolver,
    inScope: createChannelScope(http, { include: [], exclude: [] }),
  })
}

function upgrade(sessionId: string, url: string, at: number, init: { status?: number, subprotocol?: string } = {}): Exchange {
  return exchange({
    sessionId,
    url,
    resourceType: 'websocket',
    startedAt: T0 + at,
    status: init.status ?? 101,
    cookies: { session_id: 'cookie-value-must-not-leak' },
    requestHeaders: {
      Origin: `https://${HOST}`,
      ...(init.subprotocol === undefined
        ? {}
        : { 'Sec-WebSocket-Protocol': init.subprotocol }),
    },
    responseHeaders: init.subprotocol === undefined
      ? {}
      : { 'Sec-WebSocket-Protocol': init.subprotocol },
  })
}

function socketIoCapture(sessionId: string, room: string): { exchanges: Exchange[], session: LoadedSession } {
  const url = `wss://${HOST}/socket.io/?EIO=4&transport=websocket&token=${TOKEN}`
  return {
    exchanges: [
      upgrade(sessionId, url, 1_000),
    ],
    session: loadedSession(sessionId, socketEvents({
      url,
      socket: 0,
      openedAt: T0 + 1_000,
      frames: [
        ['<', '0{"sid":"Zx81kq","upgrades":[],"pingInterval":25000,"pingTimeout":20000}'],
        ['>', `40{"token":"${TOKEN}"}`],
        ['<', '40{"sid":"Hd72Lm"}'],
        ['>', `420["join",{"room":"${room}"}]`],
        ['<', '430[{"ok":true,"members":3}]'],
        ['<', `42["score",{"home":1,"away":0,"room":"${room}"}]`],
        ['<', `42["score",{"home":2,"away":0,"room":"${room}"}]`],
        ['<', '2'],
        ['>', '3'],
      ],
    })),
  }
}

describe('buildChannels with framing protocols', () => {
  const a = socketIoCapture('a', 'lobby')
  const b = socketIoCapture('b', 'finals')
  const [channel] = channelsOf([
    ...a.exchanges,
    ...b.exchanges,
  ], [a.session, b.session])

  it('names Socket.IO messages by event and gives their payloads schemas', () => {
    expect(channel?.protocol).toEqual({
      id: 'socket.io',
      version: 'Engine.IO 4',
      evidence: ['URL path ends in /socket.io/', 'frames'],
      wrapper: null,
    })
    const names = channel?.messages.map(message => `${message.direction} ${message.protocol?.frame} ${message.protocol?.name}`)
    expect(names).toEqual([
      'send connect connect',
      'send event join',
      'send pong pong',
      'receive open open',
      'receive connect connect',
      'receive ack join',
      'receive event score',
      'receive ping ping',
    ])
    const score = channel?.messages.find(message => message.protocol?.name === 'score')
    expect(score).toMatchObject({
      id: 'receiveScore',
      format: 'json',
      count: 4,
      discriminator: null,
    })
    expect(score?.schema?.properties).toMatchObject({
      home: { type: 'integer' },
      away: { type: 'integer' },
    })
    expect(score?.protocol?.wire).toBe('42["score",<payload>]')
  })

  it('lists the connect message as authentication in the handshake and the facts', () => {
    expect(channel?.handshake.map(step => [step.message, step.role])).toEqual([
      ['sendConnect', 'auth'],
      ['sendJoin', 'subscribe'],
    ])
    expect(channel?.connection).toEqual({
      origins: [`https://${HOST}`],
      subprotocols: { requested: [], selected: [] },
      urlTokens: ['token'],
      upgrade: {
        accepted: 2,
        rejected: 0,
        unknown: 0,
        statuses: [101],
      },
      firstMessage: { message: 'sendConnect', role: 'auth', reply: 'receiveConnect' },
      transports: ['websocket'],
    })
    expect(channel?.cookies).toEqual({
      status: 'sent',
      names: ['session_id'],
    })
  })

  it('never writes the auth token, from the connect payload or the URL', () => {
    const written = JSON.stringify(channel)
    expect(written).not.toContain(TOKEN)
    expect(written).not.toContain('cookie-value-must-not-leak')
    const connect = channel?.messages.find(message => message.id === 'sendConnect')
    expect(JSON.stringify(connect?.examples)).toContain('<redacted')
  })

  it('reports a rejected upgrade and the subprotocol picked', () => {
    const url = `wss://${HOST}/graphql`
    const ok = upgrade('a', url, 0, { subprotocol: 'graphql-transport-ws' })
    const refused = upgrade('b', url, 0, { status: 403, subprotocol: 'graphql-transport-ws' })
    const [graphql] = channelsOf([ok, refused], [
      loadedSession('a', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [
          ['>', '{"type":"connection_init","payload":{"Authorization":"Bearer abcdefghijklmnop1234"}}'],
          ['<', '{"type":"connection_ack"}'],
          ['>', '{"id":"1","type":"subscribe","payload":{"query":"subscription OnOdds { odds { price } }"}}'],
          ['<', '{"id":"1","type":"next","payload":{"data":{"odds":{"price":2.5}}}}'],
        ],
      })),
      loadedSession('b', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [],
      })),
    ])
    expect(graphql?.protocol?.id).toBe('graphql-ws')
    expect(graphql?.connection.upgrade).toEqual({
      accepted: 1,
      rejected: 1,
      unknown: 0,
      statuses: [101, 403],
    })
    expect(graphql?.connection.subprotocols).toEqual({
      requested: ['graphql-transport-ws'],
      selected: ['graphql-transport-ws'],
    })
    expect(graphql?.messages.map(message => message.id)).toEqual([
      'sendConnectionInit',
      'sendOnOdds',
      'receiveConnectionAck',
      'receiveOnOdds',
    ])
    expect(JSON.stringify(graphql)).not.toContain('abcdefghijklmnop1234')
  })
})

describe('engine.IO long-polling', () => {
  it('turns polling requests into the same channel as the socket, with both transports', () => {
    const base = `https://${HOST}/socket.io/?EIO=4`
    const polling = [
      exchange({
        sessionId: 's',
        url: `${base}&transport=polling&t=Pa1`,
        startedAt: T0,
        responseBody: textBody('0{"sid":"Kq19x","upgrades":["websocket"]}', 'text/plain'),
      }),
      exchange({
        sessionId: 's',
        method: 'POST',
        url: `${base}&transport=polling&t=Pa2&sid=Kq19x`,
        startedAt: T0 + 10,
        requestBody: textBody(`40{"token":"${TOKEN}"}`, 'text/plain'),
        responseBody: textBody('ok', 'text/html'),
      }),
      exchange({
        sessionId: 's',
        url: `${base}&transport=polling&t=Pa3&sid=Kq19x`,
        startedAt: T0 + 20,
        responseBody: textBody('40{"sid":"Mm2"}\x1E42["score",{"home":1}]', 'text/plain'),
      }),
    ]
    expect(polling.every(isEnginePolling)).toBe(true)
    const url = `wss://${HOST}/socket.io/?EIO=4&transport=websocket&sid=Kq19x`
    const [channel] = channelsOf([
      ...polling,
      upgrade('s', url, 30),
    ], [
      loadedSession('s', socketEvents({
        url,
        socket: 0,
        openedAt: T0 + 30,
        frames: [
          ['>', '2probe'],
          ['<', '3probe'],
          ['>', '5'],
          ['<', '42["score",{"home":2}]'],
        ],
      })),
    ])
    // The session that upgraded is one connection: its connect went over polling, its events over the socket.
    expect(channel?.connections).toBe(1)
    expect(channel?.connection.transports).toEqual(['polling', 'websocket'])
    expect(channel?.handshake.map(step => [step.message, step.role])).toEqual([
      ['sendConnect', 'auth'],
      ['sendUpgrade', 'init'],
    ])
    expect(channel?.messages.find(message => message.protocol?.name === 'score')?.count).toBe(2)
    expect(channel?.connection.firstMessage).toEqual({ message: 'sendConnect', role: 'auth', reply: 'receiveConnect' })
    expect(JSON.stringify(channel)).not.toContain(TOKEN)
  })
})

describe('engine.IO long-polling without an upgrade', () => {
  it('is a connection of its own', () => {
    const base = `https://${HOST}/socket.io/?EIO=4`
    const [channel] = channelsOf([
      exchange({
        sessionId: 's',
        url: `${base}&transport=polling`,
        startedAt: T0,
        responseBody: textBody('0{"sid":"Aa1"}', 'text/plain'),
      }),
      exchange({
        sessionId: 's',
        url: `${base}&transport=polling&sid=Aa1`,
        startedAt: T0 + 10,
        responseBody: textBody('42["score",{"home":1}]', 'text/plain'),
      }),
    ], [
      loadedSession('s', []),
    ])
    expect(channel?.connections).toBe(1)
    expect(channel?.connection.transports).toEqual(['polling'])
    expect(channel?.connection.upgrade).toEqual({
      accepted: 1,
      rejected: 0,
      unknown: 0,
      statuses: [200],
    })
    expect(channel?.messages.map(message => message.id)).toEqual(['receiveOpen', 'receiveScore'])
  })
})

describe('site input that must not crash, stall or leak', () => {
  it('survives a polling body with an invalid binary packet and a huge packet count', () => {
    const base = `https://${HOST}/socket.io/?EIO=4`
    expect(() => channelsOf([
      exchange({
        sessionId: 's',
        url: `${base}&transport=polling`,
        startedAt: T0,
        responseBody: textBody('0{"sid":"Aa1"}\x1Ebab=', 'text/plain'),
      }),
      exchange({
        sessionId: 's',
        url: `${base}&transport=polling&sid=Aa1`,
        startedAt: T0 + 10,
        responseBody: textBody('6\x1E'.repeat(5_000), 'text/plain'),
      }),
    ], [
      loadedSession('s', []),
    ])).not.toThrow()
  })

  it('never writes a token from the connection path into the protocol evidence', () => {
    const token = 'a8f3k2m9q7x4z1w6e5r0'
    const url = `wss://${HOST}/rt/${token}/socket.io/?EIO=4&transport=websocket`
    const [channel] = channelsOf([
      upgrade('s', url, 0),
    ], [
      loadedSession('s', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [
          ['<', '0{"sid":"Zx81kq"}'],
          ['>', '40'],
          ['<', '40{"sid":"Hd72Lm"}'],
          ['<', '42["score",{"a":1}]'],
        ],
      })),
    ])
    expect(channel?.protocol?.evidence).toEqual(['URL path ends in /socket.io/', 'frames'])
    expect(JSON.stringify(channel)).not.toContain(token)
    expect(channelsSection(channel === undefined
      ? []
      : [channel]).join('\n')).not.toContain(token)
  })

  it('takes no Markdown from a Phoenix event name and no secret from a STOMP header name in the wire form', () => {
    const url = `wss://${HOST}/socket/websocket?vsn=2.0.0`
    const [phoenix] = channelsOf([
      upgrade('s', url, 0),
    ], [
      loadedSession('s', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [
          [
            '>',
            JSON.stringify(['1', '1', 'room:lobby', 'phx_join', {}]),
          ],
          [
            '<',
            JSON.stringify([
              null,
              null,
              'room:lobby',
              'phx_` evil](http://x.test) **bold**',
              { a: 1 },
            ]),
          ],
        ],
      })),
    ])
    const evil = phoenix?.messages.find(message => message.direction === 'receive')
    expect(evil?.protocol?.frame).toBe('push')
    const section = channelsSection(phoenix === undefined
      ? []
      : [phoenix]).join('\n')
    expect(section).not.toContain('(phx_` evil')
    // Every copy of the name is escaped: as text (`\](`) or inside a double-backtick code span.
    expect(section).toContain('evil\\](http\\://x.test)')
    expect(section).toContain('`` room:lobby:phx_` evil](http://x.test) **bold** `` (`push`)')

    const stompUrl = `wss://${HOST}/stomp`
    const [stomp] = channelsOf([
      upgrade('t', stompUrl, 0, { subprotocol: 'v12.stomp' }),
    ], [
      loadedSession('t', socketEvents({
        url: stompUrl,
        socket: 0,
        openedAt: T0,
        frames: [
          ['>', `CONNECT\naccept-version:1.2\n${TOKEN}:1\n\n\0`],
          ['<', 'CONNECTED\nversion:1.2\n\n\0'],
        ],
      })),
    ])
    expect(stomp?.protocol?.version).toBe('1.2')
    const connect = stomp?.messages.find(message => message.protocol?.frame === 'CONNECT')
    expect(connect?.protocol?.wire).toMatch(/^CONNECT\\naccept-version:…\\n.+:…\\n\\n\\0$/)
    // The wire template names the header through the redactor. (JSON key names in schemas and
    // examples are not redacted anywhere, for HTTP bodies as for frames: a known, separate gap.)
    expect(connect?.protocol?.wire).not.toContain(TOKEN)
  })
})

describe('binary frames', () => {
  it('decodes MessagePack frames, groups them by discriminator and redacts their values', () => {
    const encoder = new TextEncoder()
    const str = (text: string): number[] => {
      const bytes = [
        ...encoder.encode(text),
      ]
      return [0xA0 | bytes.length, ...bytes]
    }
    const tick = (seq: number): Uint8Array => Uint8Array.from([
      0x83,
      ...str('type'),
      ...str('tick'),
      ...str('seq'),
      seq,
      ...str('auth'),
      0xD9,
      TOKEN.length,
      ...encoder.encode(TOKEN),
    ])
    const url = `wss://${HOST}/feed`
    const [channel] = channelsOf([
      upgrade('s', url, 0),
    ], [
      loadedSession('s', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [
          [
            '<',
            tick(1),
          ],
          [
            '<',
            tick(2),
          ],
          [
            '<',
            Uint8Array.from([0x08, 0x96, 0x01]),
          ],
          [
            '<',
            Uint8Array.from([0xC1, 0x00]),
          ],
        ],
      })),
    ])
    expect(channel?.messages.map(message => [message.id, message.format, message.count])).toEqual([
      ['receiveTick', 'msgpack', 2],
      ['receiveProtobuf', 'protobuf', 1],
      ['receiveBinary', 'binary', 1],
    ])
    const msgpack = channel?.messages[0]
    expect(msgpack?.discriminator).toEqual({ field: 'type', value: 'tick' })
    expect(msgpack?.schema?.properties).toMatchObject({
      seq: { type: 'integer' },
    })
    expect(channel?.messages[1]?.schema?.properties).toHaveProperty(['field 1 (varint)'])
    expect(JSON.stringify(channel)).not.toContain(TOKEN)
  })
})
