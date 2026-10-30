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
import { extensionPacket, packet, sfs } from './binary/sfs2x-test-packets'
import { buildChannels, channelExchanges, collectConnections, isEnginePolling, protocolSecrets } from './index'

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
  const connections = collectConnections(sessions, exchanges)
  const sockets = channelExchanges(connections)
  const redactor = createRedactor({
    exchanges: [
      ...http,
      ...sockets.exchanges,
    ],
    config: REDACT,
    knownSecrets: protocolSecrets(connections),
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
      : [channel], new Map()).join('\n')).not.toContain(token)
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
      : [phoenix], new Map()).join('\n')
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

describe('smartFoxServer 2X', () => {
  const SESSION_TOKEN = '0123456789abcdef0123456789abcdef'
  const player = (id: string, name: string, image: string): number[] => sfs.object({
    player_id: sfs.string(id),
    username: sfs.string(name),
    profileImage: sfs.string(image),
    multiplier: sfs.double(1.5),
  })
  const cashOuts = (): Uint8Array => extensionPacket('updateCurrentCashOuts', {
    code: sfs.int(200),
    openBetsCount: sfs.int(12),
    cashouts: sfs.array([
      player('40001&&demo', 'demo_90001', 'av-1.png'),
      player('40002&&demo', 'demo_40002', 'av-2.png'),
    ]),
    topPlayerProfileImages: sfs.stringArray(['av-3.png']),
  }, { compress: true })

  function sfsChannel(): WebSocketChannel | undefined {
    const url = `wss://${HOST}/BlueBox/websocket`
    return channelsOf([
      upgrade('s', url, 0),
    ], [
      loadedSession('s', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [
          [
            '>',
            packet(0, 0, {
              api: sfs.string('1.8.4'),
              cl: sfs.string('JavaScript'),
            }),
          ],
          [
            '<',
            packet(0, 0, {
              tk: sfs.string(SESSION_TOKEN),
              ct: sfs.int(1024),
            }),
          ],
          [
            '>',
            packet(0, 1, {
              zn: sfs.string('game_zone'),
              un: sfs.string('gambler7'),
              pw: sfs.string('hunter2'),
              p: sfs.object({
                token: sfs.string(TOKEN),
                k: sfs.string('kq9-launch-key'),
                ticket: sfs.string('t1'),
              }),
            }),
          ],
          [
            '<',
            packet(0, 1, {
              zn: sfs.string('game_zone'),
              un: sfs.string('gambler7'),
              id: sfs.int(123_456),
            }),
          ],
          [
            '<',
            packet(0, 4, {
              r: sfs.array([
                sfs.int(3),
                sfs.string('lobby'),
              ]),
              ul: sfs.array([
                sfs.array([
                  sfs.int(1000),
                  sfs.string('rival_anna'),
                  sfs.short(0),
                  sfs.short(1),
                  sfs.array([]),
                ]),
                sfs.array([
                  sfs.int(1001),
                  sfs.string('rival_ben'),
                  sfs.short(0),
                  sfs.short(2),
                  sfs.array([]),
                ]),
              ]),
            }),
          ],
          [
            '<',
            packet(0, 1000, {
              r: sfs.int(3),
              u: sfs.array([
                sfs.int(1002),
                sfs.string('rival_cleo'),
                sfs.short(0),
                sfs.short(3),
                sfs.array([
                  sfs.array([
                    sfs.string('nick'),
                    sfs.byte(8),
                    sfs.string('VarNickZed'),
                  ]),
                ]),
              ]),
            }),
          ],
          [
            '<',
            packet(0, 12, {
              u: sfs.int(1002),
              vl: sfs.array([
                sfs.array([
                  sfs.string('realName'),
                  sfs.byte(8),
                  sfs.string('Quill Ferro'),
                ]),
              ]),
            }),
          ],
          [
            '<',
            packet(0, 7, {
              t: sfs.byte(0),
              r: sfs.int(3),
              u: sfs.int(1000),
              m: sfs.string('meet me at table nine'),
            }),
          ],
          [
            '<',
            packet(0, 28, {
              fu: sfs.array([
                sfs.array([
                  sfs.int(1003),
                  sfs.string('rival_dora'),
                  sfs.short(0),
                  sfs.short(0),
                  sfs.array([]),
                ]),
              ]),
            }),
          ],
          [
            '<',
            packet(0, 200, {
              bl: sfs.array([
                sfs.array([
                  sfs.int(1004),
                  sfs.string('buddy_emil'),
                  sfs.bool(false),
                  sfs.array([]),
                ]),
              ]),
            }),
          ],
          [
            '<',
            packet(0, 205, {
              bn: sfs.string('buddy_emil'),
              bi: sfs.int(1004),
              o: sfs.byte(0),
            }),
          ],
          [
            '<',
            extensionPacket('lobbyStats', {
              tables: sfs.int(1000),
            }),
          ],
          [
            '<',
            cashOuts(),
          ],
          [
            '<',
            cashOuts(),
          ],
        ],
      })),
    ])[0]
  }

  it('names messages by system action and extension command, with schemas of their params', () => {
    const channel = sfsChannel()
    expect(channel?.protocol).toMatchObject({
      id: 'sfs2x',
      version: 'client API 1.8.4',
      evidence: ['URL path contains /BlueBox/', 'frames'],
    })
    expect(channel?.messages.map(message => [
      message.id,
      message.format,
      message.count,
      message.protocol?.role,
    ])).toEqual([
      ['sendHandshake', 'sfs2x', 1, 'init'],
      ['sendLogin', 'sfs2x', 1, 'auth'],
      ['receiveHandshake', 'sfs2x', 1, 'data'],
      ['receiveLogin', 'sfs2x', 1, 'data'],
      ['receiveJoinRoom', 'sfs2x', 1, 'data'],
      [
        'receiveUserEnterRoom',
        'sfs2x',
        1,
        'data',
      ],
      [
        'receiveSetUserVariables',
        'sfs2x',
        1,
        'data',
      ],
      [
        'receiveGenericMessage',
        'sfs2x',
        1,
        'data',
      ],
      ['receiveFindUsers', 'sfs2x', 1, 'data'],
      [
        'receiveInitBuddyList',
        'sfs2x',
        1,
        'data',
      ],
      ['receiveGoOnline', 'sfs2x', 1, 'data'],
      [
        'receiveLobbyStats',
        'sfs2x',
        1,
        'data',
      ],
      [
        'receiveUpdateCurrentCashOuts',
        'sfs2x',
        2,
        'data',
      ],
    ])
    const cash = channel?.messages.find(message => message.id === 'receiveUpdateCurrentCashOuts')
    expect(cash?.protocol).toMatchObject({ frame: 'extension', name: 'updateCurrentCashOuts', wire: 'SFS2X {c:1,a:13,p:{c:"updateCurrentCashOuts",p:<payload>}}' })
    expect(cash?.schema?.properties).toMatchObject({
      code: { type: 'integer' },
      cashouts: { type: 'array' },
    })
    expect(channel?.handshake.map(step => [step.message, step.role])).toEqual([
      ['sendHandshake', 'init'],
      ['sendLogin', 'auth'],
    ])
    const section = channel === undefined
      ? ''
      : channelsSection([channel], new Map()).join('\n')
    expect(section).toContain('`updateCurrentCashOuts` (`extension`) (SFS2X binary, 2×)')
  })

  it('redacts the login, the session token and other players\' identities', () => {
    const channel = sfsChannel()
    const written = JSON.stringify(channel) + (channel === undefined
      ? ''
      : channelsSection([channel], new Map()).join('\n'))
    for (const secret of [
      'gambler7',
      'hunter2',
      'kq9-launch-key',
      'rival_anna',
      'rival_ben',
      'rival_cleo',
      'rival_dora',
      'buddy_emil',
      'table nine',
      'VarNickZed',
      'Quill Ferro',
      '123456',
      SESSION_TOKEN,
      TOKEN,
      'demo_90001',
      'demo_40002',
      '40001',
      '40002',
      'av-1.png',
      'av-2.png',
      'av-3.png',
    ])
      expect(written).not.toContain(secret)
    expect(written).not.toContain('"ticket":"t1"')
    // User ids sit at known positions: masked to 0 there, and a short one is not hunted elsewhere.
    const join = channel?.messages.find(message => message.id === 'receiveJoinRoom')
    expect(join?.examples[0]).toMatchObject({
      ul: [
        [0, 'xxxxx_xxxx', 0, 1, []],
        [0, 'xxxxx_xxx', 0, 2, []],
      ],
    })
    expect(written).toContain('"tables":1000')
    // Public game data stays.
    expect(written).toContain('game_zone')
    expect(written).toContain('"openBetsCount":12')
  })
})

describe('firebase realtime database', () => {
  it('names messages by action and templated path and keeps the auth credential out', () => {
    const credential = 'invented-firebase-credential-0123456789'
    const url = `wss://${HOST}/.ws?v=5&ns=demo-board`
    const [channel] = channelsOf([
      upgrade('s', url, 0),
    ], [
      loadedSession('s', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [
          ['<', '{"t":"c","d":{"t":"h","d":{"ts":1700000000000,"v":"5","h":"demo-board.example","s":"invented-session"}}}'],
          ['>', `{"t":"d","d":{"r":1,"a":"auth","b":{"cred":"${credential}"}}}`],
          ['>', '{"t":"d","d":{"r":2,"a":"q","b":{"p":"/v0/item/41001","h":""}}}'],
          ['>', '{"t":"d","d":{"r":3,"a":"q","b":{"p":"/v0/item/41002","h":""}}}'],
          ['<', '{"t":"d","d":{"a":"d","b":{"p":"v0/item/41001","d":{"title":"Invented","score":7}}}}'],
          ['<', '{"t":"d","d":{"r":2,"b":{"s":"ok","d":{}}}}'],
        ],
      })),
    ])
    expect(channel?.protocol?.id).toBe('firebase')
    expect(channel?.messages.map(message => [message.id, message.protocol?.name, message.count])).toEqual([
      ['sendAuth', 'auth', 1],
      ['sendListenV0ItemId', 'listen /v0/item/{id}', 2],
      ['receiveHello', 'hello', 1],
      ['receiveDataV0ItemId', 'data v0/item/{id}', 1],
      ['receiveListenV0ItemId', 'listen /v0/item/{id}', 1],
    ])
    expect(channel?.handshake.map(step => [step.message, step.role])).toEqual([
      ['sendAuth', 'auth'],
      ['sendListenV0ItemId', 'subscribe'],
      ['sendListenV0ItemId', 'subscribe'],
    ])
    expect(JSON.stringify(channel)).not.toContain(credential)
  })
})

describe('firebase: secrets and people in split frames and paths', () => {
  it('keeps a secret split over two pieces, emails in paths and session ids out of the output', () => {
    const url = `wss://${HOST}/.ws?v=5&ns=demo-board&ls=InventedLastSess77`
    const [channel] = channelsOf([
      upgrade('s', url, 0),
    ], [
      loadedSession('s', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [
          ['<', '{"t":"c","d":{"t":"h","d":{"ts":1700000000000,"v":"5","h":"demo-board.example","s":"InventedSess99"}}}'],
          ['>', '{"t":"d","d":{"r":1,"a":"q","b":{"p":"/emails/quill@invented,test","h":""}}}'],
          ['>', '{"t":"d","d":{"r":2,"a":"q","b":{"p":"/users/Qk7Lp2Mx9Wz4RtBn8Yc3/private","h":""}}}'],
          ['<', '3'],
          ['<', '{"t":"d","d":{"a":"d","b":{"p":"/x","d":{"secretKey":"'],
          ['<', 'Zq8xT2mLp4VwRk7YbInvented'],
          ['<', '"}}}}'],
        ],
      })),
    ])
    const written = JSON.stringify(channel) + (channel === undefined
      ? ''
      : channelsSection([channel], new Map()).join('\n'))
    for (const value of [
      'quill@invented',
      'Qk7Lp2Mx9Wz4RtBn8Yc3',
      'Zq8xT2mLp4VwRk7YbInvented',
      'InventedSess99',
      'InventedLastSess77',
    ])
      expect(written).not.toContain(value)
    expect(channel?.messages.map(message => message.protocol?.name)).toEqual([
      'listen /emails/{id}',
      'listen /users/{id}/private',
      'hello',
      'data /x',
    ])
    expect(channel?.messages.some(message => message.protocol?.frame === 'fragment')).toBe(false)
  })
})

describe('primus: people in messages', () => {
  it('names no message after a person and templates ids in topics', () => {
    const url = `wss://${HOST}/primus/?_primuscb=Inv3nted`
    const [channel] = channelsOf([
      upgrade('s', url, 0),
    ], [
      loadedSession('s', socketEvents({
        url,
        socket: 0,
        openedAt: T0,
        frames: [
          ['<', '0{"sid":"InventedPrimusSid77","pingInterval":25000}'],
          ['<', '4{"name":"Quill Ferro","score":3}'],
          ['<', '4{"topic":"user:Qk7Lp2Mx9Wz4RtBn8Yc3","v":1}'],
          ['<', '4{"type":"chat","from":"quill@invented.test"}'],
          ['<', '4"primus::ping::123"'],
        ],
      })),
    ])
    expect(channel?.protocol?.id).toBe('primus')
    expect(channel?.messages.map(message => message.id)).toEqual([
      'receiveOpen',
      'receiveMessage',
      'receiveUserId',
      'receiveChat',
      'receivePing',
    ])
    const written = JSON.stringify(channel) + (channel === undefined
      ? ''
      : channelsSection([channel], new Map()).join('\n'))
    // A bare `name` field is not personal by the redactor's rules (only inside a person's
    // record), so the example keeps it; it must not name a message.
    expect(JSON.stringify(channel?.messages.map(message => [message.id, message.protocol]))).not.toMatch(/Quill|Qk7Lp2Mx9Wz4RtBn8Yc3/)
    for (const value of ['quill@invented.test', 'InventedPrimusSid77'])
      expect(written).not.toContain(value)
  })
})
