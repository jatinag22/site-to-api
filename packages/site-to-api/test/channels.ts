/**
 * Hand-built WebSocket channels for emitter tests: the fixture shop's ticker as the analysis
 * describes it.
 */
import type { ChannelMessage, WebSocketChannel } from '../src/model'

/** A message with empty defaults for everything not given. */
export function channelMessage(init: Partial<ChannelMessage> & Pick<ChannelMessage, 'id' | 'direction'>): ChannelMessage {
  return {
    discriminator: null,
    format: 'json',
    count: 1,
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
    summary: 'WebSocket ws ticker: the client sends subscribe; the server sends tick, text frames, binary frames.',
    ...overrides,
  }
}
