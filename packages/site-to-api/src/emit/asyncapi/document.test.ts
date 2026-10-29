import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Parser } from '@asyncapi/parser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { channelMessage as message, tickerChannel } from '../../../test/channels'
import { toYaml } from '../openapi'
import { asyncApiOperationId, buildAsyncApiDocuments } from './document'
import { writeAsyncApiDocuments } from './write'

const roomsChannel = tickerChannel({
  id: 'roomsByRoomId',
  scheme: 'wss',
  path: '/rooms/{roomId}',
  pathParams: [
    {
      name: 'roomId',
      index: 1,
      schema: {
        type: 'integer',
        examples: [8842, 1931],
      },
      evidence: ['varies', 'looks-like-id'],
    },
  ],
  query: [
    {
      name: 'lang',
      required: true,
      schema: {
        type: 'string',
        examples: ['en'],
      },
    },
    {
      name: 'v',
      required: false,
      schema: { type: 'integer' },
    },
  ],
  sentFrom: null,
  handshake: [],
  cookies: { status: 'unknown', names: [] },
  links: [
    {
      input: 'path.roomId',
      origin: {
        kind: 'html',
        operationId: 'getRooms',
        host: 'shop.test:8080',
        selector: '#room',
        attr: 'data-id',
      },
      samples: 1,
    },
  ],
})

async function validate(document: object): Promise<string[]> {
  const { diagnostics } = await new Parser().parse(toYaml(document))
  // Severity 0 is an error, 1 a warning; 2 and 3 are hints such as "a newer version exists".
  return diagnostics.filter(diagnostic => diagnostic.severity <= 1).map(diagnostic => `${diagnostic.code}: ${diagnostic.message} at ${diagnostic.path.join('.')}`)
}

describe('buildAsyncApiDocuments', () => {
  it('writes a valid AsyncAPI 3.0 document per host', async () => {
    const documents = buildAsyncApiDocuments([
      tickerChannel(),
      roomsChannel,
      tickerChannel({ host: 'rt.shop.test' }),
    ], 2)
    expect([
      ...documents.keys(),
    ]).toEqual(['rt.shop.test', 'shop.test:8080'])
    for (const document of documents.values())
      expect(await validate(document)).toEqual([])
  })

  it('describes channels, messages and operations from the client side', () => {
    const document = buildAsyncApiDocuments([
      tickerChannel(),
      roomsChannel,
    ], 2).get('shop.test:8080')
    const parsed: unknown = parse(toYaml(document ?? {}))
    expect(parsed).toMatchObject({
      asyncapi: '3.0.0',
      servers: {
        ws: { host: 'shop.test:8080', protocol: 'ws' },
        wss: { host: 'shop.test:8080', protocol: 'wss' },
      },
      channels: {
        wsTicker: {
          'address': '/ws/ticker',
          'servers': [
            { $ref: '#/servers/ws' },
          ],
          'messages': {
            sendSubscribe: {
              'name': 'subscribe',
              'contentType': 'application/json',
              'examples': [
                {
                  payload: { type: 'subscribe', productId: 1007 },
                },
              ],
              'x-site-to-api-origins': {
                'body./productId': { kind: 'response', operationId: 'getApiProducts' },
              },
            },
            receiveText: {
              contentType: 'text/plain',
              payload: { type: 'string' },
            },
            receiveBinary: {
              contentType: 'application/octet-stream',
              payload: { type: 'string', format: 'binary' },
            },
          },
          'x-site-to-api-handshake': [
            {
              message: 'sendSubscribe',
              example: { type: 'subscribe', productId: 1007 },
            },
          ],
          'x-site-to-api-cookies': {
            status: 'sent',
            names: ['sid'],
          },
          'x-site-to-api-source': [
            { file: 'src/widgets/ticker.ts', line: 22, function: 'connectPriceTicker' },
          ],
        },
        roomsByRoomId: {
          address: '/rooms/{roomId}',
          servers: [
            { $ref: '#/servers/wss' },
          ],
          parameters: {
            roomId: {
              examples: ['8842', '1931'],
            },
          },
          bindings: {
            ws: {
              query: {
                type: 'object',
                required: ['lang'],
              },
            },
          },
        },
      },
      operations: {
        wsTickerSendSubscribe: {
          action: 'send',
          channel: { $ref: '#/channels/wsTicker' },
          messages: [
            { $ref: '#/channels/wsTicker/messages/sendSubscribe' },
          ],
        },
        wsTickerReceiveTick: { action: 'receive' },
      },
    })
  })

  it('describes a path parameter by the evidence that made it one', () => {
    const describe = (evidence: Array<'source-template' | 'value-trace' | 'varies' | 'looks-like-id'>, connections: number): unknown => {
      const channel = {
        ...roomsChannel,
        connections,
        pathParams: roomsChannel.pathParams.map(param => ({ ...param, evidence })),
      }
      const parsed: unknown = parse(toYaml(buildAsyncApiDocuments([channel], 1).get('shop.test:8080') ?? {}))
      return parsed
    }
    expect(describe(['varies', 'looks-like-id'], 2)).toMatchObject({
      channels: {
        roomsByRoomId: {
          parameters: {
            roomId: { description: 'Path segment (integer) that varied between connections.' },
          },
        },
      },
    })
    expect(describe(['looks-like-id'], 1)).toMatchObject({
      channels: {
        roomsByRoomId: {
          parameters: {
            roomId: { description: 'Path segment (integer) that looks like an identifier.' },
          },
        },
      },
    })
    expect(describe(['source-template'], 1)).toMatchObject({
      channels: {
        roomsByRoomId: {
          parameters: {
            roomId: { description: 'Path segment (integer) named by a URL template in the site\'s code.' },
          },
        },
      },
    })
  })

  it('names operations by channel and message', () => {
    const channel = tickerChannel()
    expect(channel.messages.map(item => asyncApiOperationId(channel, item))).toEqual([
      'wsTickerSendSubscribe',
      'wsTickerReceiveTick',
      'wsTickerReceiveText',
      'wsTickerReceiveBinary',
    ])
  })

  it('keeps hostile site strings as plain YAML values and stays valid', async () => {
    const hostile = '"]}\n# injected: true\n`<script>`'
    const channel = tickerChannel({
      summary: hostile,
      messages: [
        message({
          id: 'sendMessage',
          direction: 'send',
          discriminator: { field: 'type', value: hostile },
          examples: [
            { type: hostile },
          ],
        }),
      ],
    })
    const document = buildAsyncApiDocuments([channel], 1).get('shop.test:8080') ?? {}
    expect(await validate(document)).toEqual([])
    const parsed: unknown = parse(toYaml(document))
    expect(parsed).toMatchObject({
      channels: {
        wsTicker: {
          summary: hostile,
          messages: {
            sendMessage: { name: hostile },
          },
        },
      },
    })
    expect(parsed).not.toHaveProperty('injected')
  })

  it('writes nothing for no channels', () => {
    expect(buildAsyncApiDocuments([], 1).size).toBe(0)
  })
})

describe('writeAsyncApiDocuments', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'site-to-api-asyncapi-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes specs/<host>.asyncapi.yaml with the OpenAPI file-name rules', async () => {
    const result = await writeAsyncApiDocuments(dir, buildAsyncApiDocuments([
      tickerChannel(),
    ], 1), ['shop.test:8080'])
    expect(result.warnings).toEqual([])
    expect(await readdir(join(dir, 'specs'))).toEqual(['shop.test_8080.asyncapi.yaml'])
    expect(await readFile(join(dir, 'specs', 'shop.test_8080.asyncapi.yaml'), 'utf8')).toMatch(/^asyncapi: 3\.0\.0\n/)
  })

  it('never overwrites the OpenAPI spec of a host whose name ends in .asyncapi', async () => {
    const result = await writeAsyncApiDocuments(dir, buildAsyncApiDocuments([
      tickerChannel({ host: 'x' }),
    ], 1), ['x.asyncapi'])
    expect(result.files).toEqual([])
    expect(result.warnings).toEqual(['The WebSocket channels of x were not written: specs/x.asyncapi.yaml is the OpenAPI spec of another host.'])
  })
})
