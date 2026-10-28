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

  it('keeps a format only when the generated client\'s validator accepts every sample', () => {
    // GitHub dates carry an offset; they are date-times, and the client must accept them.
    expect(inferSchema(s1('2026-10-23T16:21:08.000-05:00', '2026-10-09T13:53:54.000+02:00'))).toEqual({ type: 'string', format: 'date-time' })
    expect(inferSchema(s1('2026-10-23T16:21:08'))).toEqual({ type: 'string', format: 'date-time' })
    // Shapes the regexes here accept but Zod rejects: offsets without a colon, a UUID with a
    // non-RFC variant, an e-mail address without a real top-level domain, an impossible date.
    expect(inferSchema(s1('2026-10-23T16:21:08+0530'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('123e4567-e89b-12d3-c456-426614174000'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('a@b.c'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('2026-02-30'))).toEqual({ type: 'string' })
  })

  it('infers enums only with enough evidence', () => {
    expect(inferSchema(s1('NSE', 'BSE', 'NSE', 'BSE'))).toEqual({
      type: 'string',
      enum: ['BSE', 'NSE'],
    })
    // Too few samples, too little repetition, a single value, or too many distinct values.
    expect(inferSchema(s1('NSE', 'BSE'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('NSE', 'BSE', 'NSE'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('A', 'B', 'C'))).toEqual({ type: 'string' })
    expect(inferSchema(s1('A', 'A', 'A'))).toEqual({ type: 'string' })
    const many = Array.from({ length: 11 }, (_, index) => `V${index}`)
    expect(inferSchema(s1(...many, ...many))).toEqual({ type: 'string' })
    expect(inferSchema(s1('A', null, 'B', 'A', 'B'))).toEqual({
      type: ['string', 'null'],
      enum: ['A', 'B', null],
    })
  })

  it('infers enums for code-like values: UPPER_CASE, kebab and snake tokens', () => {
    expect(inferSchema(s1('IN_STOCK', 'SOLD_OUT', 'IN_STOCK', 'SOLD_OUT'))).toMatchObject({
      enum: ['IN_STOCK', 'SOLD_OUT'],
    })
    expect(inferSchema(s1('in-stock', 'out-of-stock', 'in-stock', 'out-of-stock'))).toMatchObject({
      enum: ['in-stock', 'out-of-stock'],
    })
    expect(inferSchema(s1('credit_card', 'upi', 'credit_card', 'upi'), { name: 'method' })).toEqual({ type: 'string' })
    expect(inferSchema(s1('credit_card', 'net_banking', 'credit_card', 'net_banking'))).toMatchObject({
      enum: ['credit_card', 'net_banking'],
    })
  })

  it('infers enums for plain words under code-like names, in nested objects and arrays too', () => {
    const orders = s1(
      {
        status: 'paid',
        currency: 'inr',
        items: [
          { unit: 'kg' },
          { unit: 'pack' },
        ],
      },
      {
        status: 'shipped',
        currency: 'usd',
        items: [
          { unit: 'kg' },
        ],
      },
      {
        status: 'paid',
        currency: 'inr',
        items: [
          { unit: 'pack' },
        ],
      },
      { status: 'shipped', currency: 'usd', items: [] },
    )
    const schema = inferSchema(orders)
    expect(schema.properties?.status?.enum).toEqual(['paid', 'shipped'])
    expect(schema.properties?.currency?.enum).toEqual(['inr', 'usd'])
    expect(schema.properties?.items?.items?.properties?.unit?.enum).toEqual(['kg', 'pack'])
    for (const name of [
      'orderStatus',
      'category',
      'type',
      'kind',
      'currency_code',
      'productCategories',
    ]) {
      expect(inferSchema(s1('alpha', 'beta', 'alpha', 'beta'), { name })).toMatchObject({
        enum: ['alpha', 'beta'],
      })
    }
    // Array items take the name of the array.
    expect(inferSchema(s1(['alpha', 'beta'], ['alpha'], ['beta']), { name: 'categories' })).toMatchObject({
      items: {
        enum: ['alpha', 'beta'],
      },
    })
  })

  it('never infers enums of free text, names or identifiers', () => {
    // Product names in an order, as captured from a shop: a closed enum would reject other products.
    const names = ['Glass Jar Set 250 g', 'Masala Makhana 250 g', 'Rock Salt 1 kg']
    expect(inferSchema(s1(...names, ...names, ...names), { name: 'name' })).toEqual({ type: 'string' })
    // Single words under ordinary names are data (reviewer names, category display names).
    expect(inferSchema(s1('Asha', 'Dev', 'Asha', 'Dev'), { name: 'author' })).toEqual({ type: 'string' })
    expect(inferSchema(s1('beverages', 'snacks', 'beverages', 'snacks'), { name: 'slug' })).toEqual({ type: 'string' })
    expect(inferSchema(s1('beverages', 'snacks', 'beverages', 'snacks'))).toEqual({ type: 'string' })
    // Token-shaped identifiers are not codes either.
    expect(inferSchema(s1('masala-makhana', 'rock-salt', 'masala-makhana', 'rock-salt'), { name: 'slug' })).toEqual({ type: 'string' })
    expect(inferSchema(s1('USR_1', 'USR_2', 'USR_1', 'USR_2'), { name: 'userId' })).toEqual({ type: 'string' })
    // Whitespace or length rule it out even under a code-like name.
    expect(inferSchema(s1('1 kg', '250 g', '1 kg', '250 g'), { name: 'unit' })).toEqual({ type: 'string' })
    expect(inferSchema(s1('X'.repeat(33), 'Y', 'X'.repeat(33), 'Y'), { name: 'status' })).toEqual({ type: 'string' })
  })

  it('lets the caller veto enum values', () => {
    expect(inferSchema(s1('A', 'B', 'A', 'B'), {
      allowEnumValue: value => value !== 'B',
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
