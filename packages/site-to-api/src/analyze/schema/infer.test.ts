import type { Sample } from './infer'
import { describe, expect, it } from 'vitest'
import { coerceStrings, inferSchema, inferStringSchema, MAX_SCHEMA_DEPTH } from './infer'

const s1 = (...values: unknown[]): Sample[] => values.map(value => ({ value, sessionId: 's1' }))

describe('inferSchema', () => {
  it('tells integers from numbers and merges both into number', () => {
    expect(inferSchema(s1(1, 2))).toEqual({ type: 'integer' })
    expect(inferSchema(s1(1, 2.5))).toEqual({ type: 'number' })
  })

  it('represents nullable values as type arrays', () => {
    expect(inferSchema(s1('a', null))).toEqual({
      type: ['string', 'null'],
    })
    expect(inferSchema(s1(null))).toEqual({ type: 'null' })
    expect(inferSchema([])).toEqual({})
  })

  it('marks keys present in every object as required and nests objects and arrays', () => {
    expect(inferSchema(s1(
      {
        id: 1,
        tags: ['a'],
        owner: { name: 'x' },
      },
      {
        id: 2,
        tags: [],
        owner: { name: 'y', age: 3 },
        note: null,
      },
    ))).toEqual({
      type: 'object',
      properties: {
        id: { type: 'integer' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        owner: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
          },
          required: ['name'],
        },
        note: { type: 'null' },
      },
      required: ['id', 'tags', 'owner'],
    })
  })

  it('merges array items across arrays', () => {
    expect(inferSchema(s1([
      { a: 1 },
      { a: 2, b: true },
    ]))).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          a: { type: 'integer' },
          b: { type: 'boolean' },
        },
        required: ['a'],
      },
    })
  })

  it('uses anyOf when containers mix with scalars', () => {
    expect(inferSchema(s1({ a: 1 }, 'text'))).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: {
            a: { type: 'integer' },
          },
          required: ['a'],
        },
        { type: 'string' },
      ],
    })
  })

  it.each([
    ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['date-time', '2026-01-02T03:04:05.123Z'],
    ['date', '2026-01-02'],
    ['email', 'a@b.test'],
    ['uri', 'https://shop.test/x'],
  ])('detects the %s format only when every sample matches', (format, value) => {
    expect(inferSchema(s1(value, value))).toEqual({ type: 'string', format })
    expect(inferSchema(s1(value, 'plain'))).toEqual({ type: 'string' })
  })

  it('infers enums only with enough evidence', () => {
    expect(inferSchema(s1('NSE', 'BSE', 'NSE'))).toEqual({
      type: 'string',
      enum: ['BSE', 'NSE'],
    })
    // Too few samples, no repetition, a single value, or too many distinct values.
    expect(inferSchema(s1('NSE', 'BSE'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('a', 'b', 'c'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('a', 'a', 'a'))).toEqual({ type: 'string' })
    const many = Array.from({ length: 11 }, (_, index) => `v${index}`)
    expect(inferSchema(s1(...many, ...many))).toEqual({ type: 'string' })
    expect(inferSchema(s1('x'.repeat(41), 'y', 'y'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('a', null, 'b', 'a'))).toEqual({
      type: ['string', 'null'],
      enum: ['a', 'b', null],
    })
  })

  it('lets the caller veto enum values', () => {
    expect(inferSchema(s1('a', 'b', 'a'), {
      allowEnumValue: value => value !== 'b',
    })).toEqual({ type: 'string' })
  })

  it('marks scalars identical in every sample across two or more sessions as constant', () => {
    const two = [
      {
        value: { v: 'web', n: 1 },
        sessionId: 's1',
      },
      {
        value: { v: 'web', n: 2 },
        sessionId: 's2',
      },
    ]
    expect(inferSchema(two)).toEqual({
      type: 'object',
      properties: {
        v: { 'type': 'string', 'x-constant': true },
        n: { type: 'integer' },
      },
      required: ['v', 'n'],
    })
    expect(inferSchema(s1('web', 'web'))).toEqual({ type: 'string' })
  })

  it('stops at the depth cap', () => {
    let value: unknown = 1
    for (let index = 0; index < MAX_SCHEMA_DEPTH + 3; index++)
      value = { a: value }
    let schema = inferSchema(s1(value))
    for (let index = 0; index < MAX_SCHEMA_DEPTH; index++)
      schema = schema.properties!.a!
    expect(schema.properties?.a).toEqual({ description: 'Not inferred: nested too deep' })
  })
})

describe('coerceStrings / inferStringSchema', () => {
  it('types numbers and booleans only when every value agrees', () => {
    expect(coerceStrings(['1', '20'])).toEqual([1, 20])
    expect(coerceStrings(['1.5', '2'])).toEqual([1.5, 2])
    expect(coerceStrings(['true', 'false'])).toEqual([true, false])
    expect(coerceStrings(['1', 'x'])).toEqual(['1', 'x'])
    expect(coerceStrings(['007'])).toEqual(['007'])
    expect(inferStringSchema([
      { value: '10', sessionId: 's1' },
    ])).toEqual({ type: 'integer' })
  })
})
