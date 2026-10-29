import type { ResolvedConfig } from '../../config/schema'
import type { KeyedFrame } from './messages'
import { describe, expect, it } from 'vitest'
import { createRedactor } from '../redact'
import { parseFrameJson } from './connections'
import { chooseDiscriminator, groupMessages } from './messages'

const REDACT: ResolvedConfig['redact'] = {
  examples: 'masked',
  maxExamples: 3,
  patterns: [],
  fields: [],
}
const redactor = createRedactor({ exchanges: [], config: REDACT })
const safe = (): boolean => true

function frames(data: Array<string | Uint8Array>, direction: 'sent' | 'received' = 'received', sessionId = 's1'): KeyedFrame[] {
  return data.map((item, index) => {
    const binary = typeof item !== 'string'
    const text = binary
      ? btoa(String.fromCharCode(...item))
      : item
    return {
      key: `${sessionId}:ws:0:${index}`,
      sessionId,
      frame: {
        direction,
        ts: index,
        data: text,
        binary,
        json: binary
          ? undefined
          : parseFrameJson(text),
      },
    }
  })
}

describe('chooseDiscriminator', () => {
  const field = (messages: readonly unknown[], isSafe: (name: string, value: string) => boolean = safe): string | null => chooseDiscriminator(messages, isSafe).field

  it('prefers well-known names in order, even with a single value', () => {
    expect(field([
      { type: 'tick', event: 'a' },
      { type: 'tick', event: 'b' },
    ])).toBe('type')
    expect(field([
      { event: 'join', room: 'a' },
      { event: 'leave', room: 'a' },
    ])).toBe('event')
    expect(field([
      { jsonrpc: '2.0', method: 'subscribe', id: '1' },
    ])).toBe('method')
  })

  it('needs the field, as a non-empty string, in most messages', () => {
    expect(field([
      { type: 'a' },
      { kind: 'b' },
    ])).toBeNull()
    expect(field([
      { type: 'a' },
      { type: 3 },
    ])).toBeNull()
    expect(field([
      { type: 'a' },
      { type: '' },
    ])).toBeNull()
  })

  it('groups by a field most messages have, leaving acknowledgements out', () => {
    // A stream feed: data messages name their stream; the replies to subscriptions do not.
    const messages = [
      ...Array.from({ length: 6 }, () => ({
        stream: 'btc@trade',
        data: { e: 'trade', p: '1' },
      })),
      ...Array.from({ length: 3 }, () => ({
        stream: 'btc@depth',
        data: { e: 'depthUpdate' },
      })),
      // A ticker array: `data.e` is not on every data message, `stream` is.
      ...Array.from({ length: 2 }, () => ({
        stream: '!mini@arr',
        data: [
          { e: '24hrMiniTicker' },
        ],
      })),
      { result: null, id: 1 },
    ]
    expect(field(messages)).toBe('stream')
  })

  it('looks one object down when no top-level field names the type', () => {
    const messages = [
      {
        data: { e: 'trade', p: '1' },
      },
      {
        data: { e: 'trade', p: '2' },
      },
      {
        data: { e: 'kline', k: {} },
      },
    ]
    expect(field(messages)).toBe('data.e')
  })

  it('falls back to the shared field with the fewest distinct values that repeat', () => {
    const messages = [
      { channel: 'prices', at: '2026-01-01T00:00:01Z' },
      { channel: 'prices', at: '2026-01-01T00:00:02Z' },
      { channel: 'orders', at: '2026-01-01T00:00:03Z' },
    ]
    expect(field(messages)).toBe('channel')
  })

  it('rejects fields that are ids or constants unless their name says otherwise', () => {
    expect(field([
      { id: 'a1' },
      { id: 'b2' },
      { id: 'c3' },
    ])).toBeNull()
    expect(field([
      { version: '2.0' },
      { version: '2.0' },
    ])).toBeNull()
  })

  it('accepts a few dozen message types, and says which field had too many', () => {
    const feed = Array.from({ length: 60 }, (_, index) => ({
      op: index < 40
        ? 'tick'
        : `evt${index % 20}`,
      seq: index,
    }))
    expect(field(feed)).toBe('op')
    const many = Array.from({ length: 80 }, (_, index) => ({ type: `t${index % 40}` }))
    expect(chooseDiscriminator(many, safe)).toEqual({
      field: null,
      tooMany: { field: 'type', values: 40 },
    })
    expect(field([
      { type: 'a' },
      { type: 'jane@example.org' },
    ], (_, value) => !value.includes('@'))).toBeNull()
  })

  it('needs most messages to be JSON objects', () => {
    expect(field([
      { type: 'a' },
      ['type', 'b'],
    ])).toBeNull()
    expect(field([])).toBeNull()
  })
})

describe('groupMessages', () => {
  it('groups JSON messages by discriminator, in first-seen order, with a schema and examples each', () => {
    const { messages, messageOf } = groupMessages('receive', frames([
      '{"type":"hello","channel":"prices"}',
      '{"type":"tick","productId":1007,"price":10.5}',
      '{"type":"tick","productId":1007,"price":11}',
      '{"type":"tick","productId":1007}',
    ]), redactor, new Set())
    expect(messages.map(message => [message.id, message.count, message.format])).toEqual([
      ['receiveHello', 1, 'json'],
      ['receiveTick', 3, 'json'],
    ])
    const tick = messages[1]!
    expect(tick.discriminator).toEqual({ field: 'type', value: 'tick' })
    expect(tick.schema).toEqual({
      type: 'object',
      properties: {
        type: { type: 'string', const: 'tick' },
        productId: { type: 'integer' },
        price: { type: 'number' },
      },
      required: ['type', 'productId'],
    })
    expect(tick.examples).toHaveLength(3)
    expect(messageOf.get('s1:ws:0:0')).toBe('receiveHello')
    expect(messageOf.get('s1:ws:0:3')).toBe('receiveTick')
  })

  it('keeps one JSON group without a discriminator, and groups text and binary frames apart', () => {
    const { messages } = groupMessages('send', frames([
      '{"seq":1}',
      'ping',
      new Uint8Array([1, 2, 3]),
      '{"seq":2}',
      'ping',
    ], 'sent'), redactor, new Set())
    expect(messages.map(message => [message.id, message.format, message.count])).toEqual([
      ['sendMessage', 'json', 2],
      ['sendText', 'text', 2],
      ['sendBinary', 'binary', 1],
    ])
    expect(messages[1]).toMatchObject({
      schema: null,
      shapes: ['4 chars'],
      examples: ['ping'],
    })
    expect(messages[2]).toMatchObject({ schema: null, shapes: [], examples: [] })
  })

  it('groups by a nested field, pins it in the schema, and says when grouping was impossible', () => {
    const grouped = groupMessages('receive', frames([
      '{"data":{"e":"trade","p":"1"}}',
      '{"data":{"e":"trade","p":"2"}}',
      '{"data":{"e":"kline","k":"x"}}',
    ]), redactor, new Set())
    expect(grouped.messages.map(message => message.id)).toEqual(['receiveTrade', 'receiveKline'])
    expect(grouped.messages[0]?.schema?.properties?.data?.properties?.e).toEqual({ type: 'string', const: 'trade' })
    expect(grouped.ungrouped).toBeNull()
    const mixed = groupMessages('receive', frames([
      '{"a":1}',
      '{"b":2}',
      '{"a":3}',
    ]), redactor, new Set())
    expect(mixed.ungrouped).toEqual({ direction: 'receive', field: null, values: null })
  })

  it('records how many frames the schema was inferred from', () => {
    const { messages } = groupMessages('receive', frames(Array.from({ length: 1005 }, (_, seq) => `{"type":"tick","seq":${seq}}`)), redactor, new Set())
    expect(messages[0]).toMatchObject({ count: 1005, schemaSamples: 1000 })
  })

  it('gives every group an id that is a usable key, unique within the channel', () => {
    const used = new Set(['sendTick'])
    const { messages } = groupMessages('send', frames([
      '{"type":"tick"}',
      '{"type":"Tick"}',
      '{"type":"price-update"}',
      '{"type":"$$$"}',
    ], 'sent'), redactor, used)
    expect(messages.map(message => message.id)).toEqual([
      'sendTick2',
      'sendTick3',
      'sendPriceUpdate',
      'sendMessage',
    ])
    expect(messages.every(message => /^[\w-]+$/.test(message.id))).toBe(true)
  })

  it('redacts secrets and personal data in examples and never lists them as enum values', () => {
    const jwt = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: 'u1' }))}.c2lnbmF0dXJl`.replace(/=/g, '')
    const { messages } = groupMessages('send', frames([
      `{"type":"auth","token":"${jwt}","email":"jane.doe@example.org"}`,
      `{"type":"auth","token":"${jwt}","email":"jane.doe@example.org"}`,
      `{"type":"auth","token":"${jwt}","email":"john.doe@example.org"}`,
      `{"type":"auth","token":"${jwt}","email":"john.doe@example.org"}`,
    ], 'sent'), redactor, new Set())
    const text = JSON.stringify(messages)
    expect(text).not.toContain(jwt)
    expect(text).not.toContain('jane.doe')
    expect(text).not.toContain('john.doe')
    expect(messages[0]!.schema?.properties?.email?.enum).toBeUndefined()
  })
})
