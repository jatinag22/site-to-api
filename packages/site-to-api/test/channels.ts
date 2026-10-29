/**
 * Hand-built WebSocket channels for emitter tests: the fixture shop's ticker as the analysis
 * describes it.
 */
import type { ChannelMessage, WebSocketChannel } from '../src/model'

/** A message with empty defaults for everything not given. */
export function channelMessage(init: Partial<ChannelMessage> & Pick<ChannelMessage, 'id' | 'direction'>): ChannelMessage {
  return {
    discriminator: null,
    protocol: null,
    format: 'json',
    count: 1,
    schemaSamples: init.format === 'text' || init.format === 'binary'
      ? null
      : init.count ?? 1,
    schema: { type: 'object', properties: {} },
    shapes: [],
    examples: [],
    links: [],
    ...init,
  }
}

/** The fixture shop's ticker, as the analysis describes it. */
export function tickerChannel(overrides: Partial<WebSocketChannel> = {}): WebSocketChannel {
  return {
    id: 'wsTicker',
    host: 'shop.test:8080',
    scheme: 'ws',
    path: '/ws/ticker',
    pathParams: [],
    query: [],
    connections: 2,
    ungrouped: [],
    sentFrom: {
      file: 'src/widgets/ticker.ts',
      line: 22,
      column: 3,
      functionName: 'connectPriceTicker',
      original: true,
      excerpt: null,
    },
    messages: [
      channelMessage({
        id: 'sendSubscribe',
        direction: 'send',
        discriminator: { field: 'type', value: 'subscribe' },
        count: 2,
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'subscribe' },
            productId: { type: 'integer' },
          },
          required: ['type', 'productId'],
        },
        examples: [
          { type: 'subscribe', productId: 1007 },
        ],
        links: [
          {
            input: 'body./productId',
            origin: {
              kind: 'response',
              operationId: 'getApiProducts',
              host: 'shop.test:8080',
              output: 'body./items/0/id',
              transform: 'none',
            },
            samples: 2,
          },
        ],
      }),
      channelMessage({
        id: 'receiveTick',
        direction: 'receive',
        discriminator: { field: 'type', value: 'tick' },
        count: 6,
        schema: {
          'type': 'object',
          'properties': {
            type: { type: 'string', const: 'tick' },
            price: { type: 'number' },
          },
          'x-constant': false,
        },
        examples: [
          { type: 'tick', price: 10.5 },
        ],
      }),
      channelMessage({
        id: 'receiveText',
        direction: 'receive',
        format: 'text',
        schema: null,
        shapes: ['4 chars'],
        examples: ['pong'],
      }),
      channelMessage({
        id: 'receiveBinary',
        direction: 'receive',
        format: 'binary',
        schema: null,
      }),
    ],
    handshake: [
      {
        message: 'sendSubscribe',
        role: 'subscribe',
        example: { type: 'subscribe', productId: 1007 },
      },
    ],
    cookies: {
      status: 'sent',
      names: ['sid'],
    },
    links: [],
    protocol: null,
    connection: {
      origins: ['http://shop.test:8080'],
      subprotocols: { requested: [], selected: [] },
      urlTokens: [],
      upgrade: {
        accepted: 2,
        rejected: 0,
        unknown: 0,
        statuses: [101],
      },
      firstMessage: null,
      transports: ['websocket'],
    },
    summary: 'WebSocket ws ticker: the client sends subscribe; the server sends tick, text frames, binary frames.',
    ...overrides,
  }
}

/** A Socket.IO chat channel, as the analysis describes one with a detected protocol. */
export function socketIoChannel(overrides: Partial<WebSocketChannel> = {}): WebSocketChannel {
  const protocol = (frame: string, name: string, role: NonNullable<ChannelMessage['protocol']>['role'], wire: string): ChannelMessage['protocol'] => ({
    protocol: 'socket.io',
    frame,
    name,
    role,
    wire,
  })
  return tickerChannel({
    id: 'socketIo',
    scheme: 'wss',
    path: '/socket.io/',
    sentFrom: null,
    messages: [
      channelMessage({
        id: 'sendConnect',
        direction: 'send',
        protocol: protocol('connect', 'connect', 'auth', '40<payload>'),
        schema: {
          type: 'object',
          properties: {
            token: { type: 'string' },
          },
        },
        examples: [
          { token: '<redacted: JWT (HS256)>' },
        ],
      }),
      channelMessage({
        id: 'sendChatMessage',
        direction: 'send',
        protocol: protocol('event', 'chat message', 'data', '42["chat message",<payload>]'),
        count: 3,
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
        },
      }),
      channelMessage({
        id: 'receiveConnect',
        direction: 'receive',
        protocol: protocol('connect', 'connect', 'init', '40<payload>'),
      }),
      channelMessage({
        id: 'receivePing',
        direction: 'receive',
        format: 'text',
        schema: null,
        protocol: protocol('ping', 'ping', 'keepalive', '2'),
      }),
      channelMessage({
        id: 'receiveMsgpack',
        direction: 'receive',
        format: 'msgpack',
        count: 4,
      }),
    ],
    handshake: [
      {
        message: 'sendConnect',
        role: 'auth',
        example: { token: '<redacted: JWT (HS256)>' },
      },
    ],
    cookies: { status: 'none', names: [] },
    protocol: {
      id: 'socket.io',
      version: 'Engine.IO 4',
      evidence: ['URL path /socket.io/', 'frames'],
      wrapper: null,
    },
    connection: {
      origins: ['https://chat.test'],
      subprotocols: { requested: [], selected: [] },
      urlTokens: ['token'],
      upgrade: {
        accepted: 1,
        rejected: 1,
        unknown: 0,
        statuses: [101, 403],
      },
      firstMessage: { message: 'sendConnect', role: 'auth', reply: 'receiveConnect' },
      transports: ['polling', 'websocket'],
    },
    summary: 'WebSocket socket io: the client sends connect, chat message; the server sends connect, ping, MessagePack frames.',
    ...overrides,
  })
}
