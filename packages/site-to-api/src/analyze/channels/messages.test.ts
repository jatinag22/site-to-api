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
  it('prefers well-known names in order, even with a single value', () => {
    expect(chooseDiscriminator([
      { type: 'tick', event: 'a' },
      { type: 'tick', event: 'b' },
    ], safe)).toBe('type')
    expect(chooseDiscriminator([
      { event: 'join', room: 'a' },
      { event: 'leave', room: 'a' },
    ], safe)).toBe('event')
    expect(chooseDiscriminator([
      { jsonrpc: '2.0', method: 'subscribe', id: '1' },
    ], safe)).toBe('method')
  })

  it('needs the field in every message, as a non-empty string', () => {
    expect(chooseDiscriminator([
      { type: 'a' },
      { kind: 'b' },
    ], safe)).toBeNull()
    expect(chooseDiscriminator([
      { type: 'a' },
      { type: 3 },
    ], safe)).toBeNull()
    expect(chooseDiscriminator([
      { type: 'a' },
      { type: '' },
    ], safe)).toBeNull()
  })

  it('falls back to the shared field with the fewest distinct values that repeat', () => {
    const messages = [
      { channel: 'prices', at: '2026-01-01T00:00:01Z' },
      { channel: 'prices', at: '2026-01-01T00:00:02Z' },
      { channel: 'orders', at: '2026-01-01T00:00:03Z' },
    ]
    expect(chooseDiscriminator(messages, safe)).toBe('channel')
  })

  it('rejects fields that are ids or constants unless their name says otherwise', () => {
    expect(chooseDiscriminator([
      { id: 'a1' },
      { id: 'b2' },
      { id: 'c3' },
    ], safe)).toBeNull()
    expect(chooseDiscriminator([
      { version: '2.0' },
      { version: '2.0' },
    ], safe)).toBeNull()
  })

  it('rejects fields with too many values and values the redactor would change', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ type: `t${index % 20}` }))
    expect(chooseDiscriminator(many, safe)).toBeNull()
    expect(chooseDiscriminator([
      { type: 'a' },
      { type: 'jane@example.org' },
    ], (_, value) => !value.includes('@'))).toBeNull()
  })

  it('needs every message to be a JSON object', () => {
    expect(chooseDiscriminator([
      { type: 'a' },
      ['type', 'b'],
    ], safe)).toBeNull()
    expect(chooseDiscriminator([], safe)).toBeNull()
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
