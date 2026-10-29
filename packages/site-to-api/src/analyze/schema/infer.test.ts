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

  it('describes objects keyed by data as maps, keeping ordinary keys as properties', () => {
    const isMapKey = (key: string): boolean => key.startsWith('tok_')
    const schema = inferSchema(s1(
      {
        sessions: {
          tok_a: { device: 'web' },
          tok_b: { device: 'ios', current: true },
        },
        count: 2,
      },
      {
        sessions: {
          tok_c: { device: 'web' },
        },
        count: 1,
      },
      { sessions: {}, count: 0 },
    ), { isMapKey })
    expect(schema).toEqual({
      type: 'object',
      properties: {
        sessions: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              device: { type: 'string' },
              current: { type: 'boolean' },
            },
            required: ['device'],
          },
        },
        count: { type: 'integer' },
      },
      required: ['sessions', 'count'],
    })
    expect(JSON.stringify(schema)).not.toContain('tok_')
  })

  it('lists ordinary keys beside the map values of a mixed object, and requires only them', () => {
    const schema = inferSchema(s1(
      { total: 1, tok_a: 5 },
      { total: 2, tok_b: 6.5 },
    ), {
      isMapKey: key => key.startsWith('tok_'),
    })
    expect(schema).toEqual({
      type: 'object',
      properties: {
        total: { type: 'integer' },
      },
      required: ['total'],
      additionalProperties: { type: 'number' },
    })
  })

  it('treats every key as a property without isMapKey', () => {
    expect(inferSchema(s1({ tok_a: 1 })).properties).toEqual({
      tok_a: { type: 'integer' },
    })
  })

  it('keeps keys named like Object.prototype members as plain properties', () => {
    const value = JSON.parse('{"__proto__":{"x":1},"constructor":"c","toString":2}') as unknown
    const schema = inferSchema(s1(value))
    expect(Object.keys(schema.properties ?? {})).toEqual([
      '__proto__',
      'constructor',
      'toString',
    ])
    expect(Object.getPrototypeOf(schema.properties)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(schema.properties, '__proto__')?.value).toEqual({
      type: 'object',
      properties: {
        x: { type: 'integer' },
      },
      required: ['x'],
    })
    expect(schema.required).toEqual([
      '__proto__',
      'constructor',
      'toString',
    ])
    expect(JSON.stringify(schema)).toContain('"__proto__":{"type":"object"')
  })
})

describe('coerceStrings / inferStringSchema', () => {
  it('types numbers and booleans only when every value agrees', () => {
    expect(coerceStrings(['1', '20'])).toEqual([1, 20])
    expect(coerceStrings(['1.5', '2'])).toEqual([1.5, 2])
    expect(coerceStrings(['true', 'false'])).toEqual([true, false])
    expect(coerceStrings(['1', 'x'])).toEqual(['1', 'x'])
    expect(coerceStrings(['007'])).toEqual(['007'])
    expect(coerceStrings(['007', '120'], 'page')).toEqual(['007', '120'])
  })

  it('keeps digit codes as strings and real numbers as numbers', () => {
    // IKEA `itemNos`, Spotify `totp`: codes by name, and by a fixed length of six or more digits.
    expect(coerceStrings(['90529469'], 'itemNos')).toEqual(['90529469'])
    expect(coerceStrings(['12', '345'], 'userId')).toEqual(['12', '345'])
    expect(coerceStrings(['560001'], 'pincode')).toEqual(['560001'])
    expect(coerceStrings(['123456', '654321'], 'totp')).toEqual(['123456', '654321'])
    expect(coerceStrings(['123456', '654321'], 'value')).toEqual(['123456', '654321'])
    expect(inferStringSchema([
      { value: '90529469', sessionId: 's1' },
    ], { name: 'itemNos' })).toMatchObject({ type: 'string' })
    // Amounts, counts and pages stay numbers.
    expect(coerceStrings(['1', '20'], 'page')).toEqual([1, 20])
    expect(coerceStrings(['1500', '250000'], 'price')).toEqual([1500, 250000])
    expect(coerceStrings(['2.5'], 'productId')).toEqual([2.5])
    expect(coerceStrings(['3'], 'width')).toEqual([3])
    expect(coerceStrings(['1', '2'], 'notes')).toEqual([1, 2])
    expect(inferStringSchema([
      { value: '10', sessionId: 's1' },
    ])).toEqual({ type: 'integer' })
  })

  it('matches code names as whole words or known compounds, never page numbers or counts', () => {
    expect(coerceStrings(['1', '2', '3'], 'pageNumber')).toEqual([1, 2, 3])
    expect(coerceStrings(['1', '2'], 'pageNo')).toEqual([1, 2])
    expect(coerceStrings(['4'], 'numberOfGuests')).toEqual([4])
    expect(coerceStrings(['1', '2'], 'encode')).toEqual([1, 2])
    expect(coerceStrings(['0', '1'], 'decode')).toEqual([0, 1])
    expect(coerceStrings(['91'], 'countryCode')).toEqual(['91'])
    expect(coerceStrings(['400001'], 'postcode')).toEqual(['400001'])
    expect(coerceStrings(['8901234567890'], 'barcode')).toEqual(['8901234567890'])
    expect(coerceStrings(['9876543210'], 'phoneNumber')).toEqual(['9876543210'])
  })

  it('needs two different values for the fixed-length rule, and never takes Unix times for codes', () => {
    expect(coerceStrings(['250000'], 'amount')).toEqual([250000])
    expect(coerceStrings(['250000', '250000'], 'amount')).toEqual([250000, 250000])
    expect(coerceStrings(['1730000000', '1730000500'], 'since')).toEqual([1730000000, 1730000500])
    expect(coerceStrings(['1730000000001', '1730000000002'], 'since')).toEqual([1730000000001, 1730000000002])
    expect(coerceStrings(['123456', '654321'], 'value')).toEqual(['123456', '654321'])
  })
})

describe('enums of digit strings', () => {
  it('never makes an enum when every value is all digits', () => {
    for (const name of [
      'storeCode',
      'postalCode',
      'zipCode',
      'areaCode',
      'countryCode',
    ]) {
      const schema = inferStringSchema(['1234', '1234', '5678', '5678'].map(value => ({ value, sessionId: 's1' })), { name })
      expect(schema, name).toEqual({ type: 'string' })
    }
    const json = inferSchema(['1234', '1234', '5678', '5678'].map(value => ({
      value: { storeCode: value },
      sessionId: 's1',
    })))
    expect(json.properties?.storeCode).toEqual({ type: 'string' })
    // Code words still get enums.
    const letters = inferStringSchema(['IN', 'IN', 'US', 'US'].map(value => ({ value, sessionId: 's1' })), { name: 'countryCode' })
    expect(letters.enum).toEqual(['IN', 'US'])
  })
})

describe('enums never come from live data', () => {
  it('does not put an enum on strings that sit next to numbers in a tuple', () => {
    // A chart row as NSE sends it: timestamp, price, flag, change, percent.
    const rows = [
      [
        1793178000000,
        22749.75,
        'PO',
        0,
        -0.01,
      ],
      [
        1793178059000,
        22634.3,
        'PO',
        -115.45,
        -0.51,
      ],
      [
        1793178119000,
        22640.1,
        'NM',
        -109.65,
        -0.48,
      ],
      [
        1793178179000,
        22641.2,
        'NM',
        -108.55,
        -0.48,
      ],
      [
        1793178239000,
        22650.9,
        'IC',
        -98.85,
        -0.43,
      ],
      [
        1793178299000,
        22655.4,
        'IC',
        -94.35,
        -0.41,
      ],
    ]
    const schema = inferSchema(s1({ data: rows }))
    expect(schema.properties?.data?.items?.items).toEqual({
      type: ['string', 'number'],
    })
    // The live rows (other prices, other flags) must validate against the inferred schema.
    expect(JSON.stringify(schema)).not.toContain('enum')
  })

  it('does not make enums of numeric-looking strings, signed or with decimals', () => {
    for (const values of [
      ['12.50', '12.50', '99.00', '99.00'],
      ['-0.51', '-0.51', '0.4', '0.4'],
      ['1', '1', '2', '2'],
      ['+5', '+5', 'IN', 'IN'],
    ])
      expect(inferStringSchema(values.map(value => ({ value, sessionId: 's1' })), { name: 'status' })).not.toHaveProperty('enum')
  })

  it('does not make an enum of values that differ across most samples', () => {
    const prices = [
      'A1',
      'B2',
      'C3',
      'D4',
      'E5',
      'F6',
      'G7',
      'A1',
    ]
    expect(inferStringSchema(prices.map(value => ({ value, sessionId: 's1' })), { name: 'status' })).toEqual({ type: 'string' })
  })

  it('keeps real enums: status words, letter codes and code tokens', () => {
    expect(inferStringSchema(['Active', 'Closed', 'Active', 'Closed'].map(value => ({ value, sessionId: 's1' })), { name: 'status' }).enum).toEqual(['Active', 'Closed'])
    expect(inferStringSchema(['EQ', 'T0', 'EQ', 'T0'].map(value => ({ value, sessionId: 's1' })), { name: 'series' }).enum).toEqual(['EQ', 'T0'])
    expect(inferSchema(s1('IN_STOCK', 'SOLD_OUT', 'IN_STOCK', 'SOLD_OUT')).enum).toEqual(['IN_STOCK', 'SOLD_OUT'])
  })
})
