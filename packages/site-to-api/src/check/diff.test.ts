import type { JsonSchema } from '../model'
import { describe, expect, it } from 'vitest'
import { diffAgainstSchema } from './diff'

const product: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    price: { type: 'number' },
    note: {
      type: ['string', 'null'],
    },
  },
  required: ['id', 'name'],
}

describe('diffAgainstSchema', () => {
  it('reports nothing for a body that matches, including optional fields left out', () => {
    expect(diffAgainstSchema(product, { id: 1, name: 'Tea' })).toEqual({ added: [], removed: [], typeChanged: [] })
  })

  it('reports a field the schema does not list as added', () => {
    expect(diffAgainstSchema(product, { id: 1, name: 'Tea', badge: 'new' }).added).toEqual(['$.badge'])
  })

  it('reports a missing required field as removed, and ignores a missing optional one', () => {
    const diff = diffAgainstSchema(product, { id: 1 })
    expect(diff.removed).toEqual(['$.name'])
    expect(diff.added).toEqual([])
  })

  it('reports a changed type with the path, and accepts an integer where a number is allowed', () => {
    const diff = diffAgainstSchema(product, { id: '1', name: 'Tea', price: 3 })
    expect(diff.typeChanged).toEqual([
      { path: '$.id', expected: 'integer', actual: 'string' },
    ])
  })

  it('treats a fractional number as a change from integer', () => {
    expect(diffAgainstSchema(product, { id: 1.5, name: 'x' }).typeChanged).toEqual([
      { path: '$.id', expected: 'integer', actual: 'number' },
    ])
  })

  it('accepts null where the schema allows it and rejects it otherwise', () => {
    expect(diffAgainstSchema(product, { id: 1, name: 'x', note: null }).typeChanged).toEqual([])
    expect(diffAgainstSchema(product, { id: 1, name: null }).typeChanged).toEqual([
      { path: '$.name', expected: 'string', actual: 'null' },
    ])
  })

  it('reports a different root type at $', () => {
    expect(diffAgainstSchema(product, [1]).typeChanged).toEqual([
      { path: '$', expected: 'object', actual: 'array' },
    ])
  })

  it('walks array items once per distinct problem, with [] for any element', () => {
    const schema: JsonSchema = { type: 'array', items: product }
    const diff = diffAgainstSchema(schema, [
      { id: 1, name: 'a', extra: 1 },
      { id: 2, name: 'b', extra: 2 },
      { id: 3 },
    ])
    expect(diff.added).toEqual(['$[].extra'])
    expect(diff.removed).toEqual(['$[].name'])
  })

  it('walks nested objects', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { page: product },
      required: ['page'],
    }
    expect(diffAgainstSchema(schema, {
      page: { id: 1, name: 'x', more: true },
    }).added).toEqual(['$.page.more'])
    expect(diffAgainstSchema(schema, {}).removed).toEqual(['$.page'])
  })

  it('treats additionalProperties as a map: its keys are never listed, its values are checked', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: { type: 'number' },
    }
    expect(diffAgainstSchema(schema, { 'a@example.com': 1, 'b@example.com': 2 })).toEqual({ added: [], removed: [], typeChanged: [] })
    expect(diffAgainstSchema(schema, { 'a@example.com': 'x' }).typeChanged).toEqual([
      { path: '$.*', expected: 'number', actual: 'string' },
    ])
  })

  it('does not call keys added on an object the schema leaves open', () => {
    expect(diffAgainstSchema({ type: 'object' }, { anything: 1 }).added).toEqual([])
    expect(diffAgainstSchema({}, { anything: 1 })).toEqual({ added: [], removed: [], typeChanged: [] })
  })

  it('reports a value outside an enum without naming the value', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'closed'],
        },
      },
      required: ['status'],
    }
    const diff = diffAgainstSchema(schema, { status: 'archived' })
    expect(diff.typeChanged).toEqual([
      { path: '$.status', expected: 'enum', actual: 'value outside the enum' },
    ])
    expect(JSON.stringify(diff)).not.toContain('archived')
    expect(diffAgainstSchema(schema, { status: 'open' }).typeChanged).toEqual([])
  })

  it('accepts a value one anyOf branch accepts, and reports the closest branch otherwise', () => {
    const schema: JsonSchema = {
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: {
            a: { type: 'integer' },
          },
          required: ['a'],
        },
      ],
    }
    expect(diffAgainstSchema(schema, 'x')).toEqual({ added: [], removed: [], typeChanged: [] })
    expect(diffAgainstSchema(schema, { a: 1 }).typeChanged).toEqual([])
    expect(diffAgainstSchema(schema, {}).removed).toEqual(['$.a'])
  })

  it('sorts and deduplicates, so the same drift always reads the same', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
      },
    }
    expect(diffAgainstSchema(schema, { z: 1, b: 2, a: 'x' }).added).toEqual(['$.b', '$.z'])
  })

  describe('keys the capture never saw', () => {
    const fields: JsonSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
    }

    it('prints an ordinary field name and writes the shape of anything that looks like data', () => {
      const added = diffAgainstSchema(fields, {
        'id': 1,
        'badge': 1,
        'x-total': 1,
        'a1b2c3d4e5f60718293a4b5c6d7e8f90': 1,
        'jane.doe@example.com': 1,
        '7c9e6679-7425-40de-944b-e07fc1f90ae7': 1,
        '48151623': 1,
      }).added
      expect(added).toEqual([
        '$.<32 hex chars>',
        '$.<36 chars>',
        '$.<20 chars>',
        '$.<8 hex chars>',
        '$.badge',
        '$.x-total',
      ].sort())
      expect(JSON.stringify(added)).not.toMatch(/jane|7c9e6679|48151623|a1b2c3d4/)
    })

    it('writes one entry for many keys of one shape', () => {
      const keys = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [
        `${'0123456789abcdef'.repeat(2).slice(i)}${'ab'.repeat(i)}`.slice(0, 32),
        1,
      ]))
      expect(diffAgainstSchema(fields, { id: 1, ...keys }).added).toEqual(['$.<32 hex chars>'])
    })

    it('treats extra keys of an object keyed by data as map entries: no drift, values still checked', () => {
      const byId: JsonSchema = {
        type: 'object',
        properties: {
          '7c9e6679-7425-40de-944b-e07fc1f90ae7': {
            type: 'object',
            properties: {
              n: { type: 'integer' },
            },
            required: ['n'],
          },
        },
      }
      expect(diffAgainstSchema(byId, {
        'ffffffff-7425-40de-944b-e07fc1f90ae7': { n: 1 },
        'eeeeeeee-7425-40de-944b-e07fc1f90ae7': { n: 2 },
      })).toEqual({ added: [], removed: [], typeChanged: [] })
      expect(diffAgainstSchema(byId, {
        'ffffffff-7425-40de-944b-e07fc1f90ae7': { n: 'x' },
      }).typeChanged).toEqual([
        { path: '$.*.n', expected: 'integer', actual: 'string' },
      ])
    })
  })

  describe('bounds and unions', () => {
    const items: JsonSchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
        },
        required: ['id'],
      },
    }

    it('inspects the first 500 array items and no more', () => {
      const body = Array.from({ length: 600 }, () => ({ id: 1 }))
      const inside = body.map((item, i) => i === 499
        ? { ...item, extra: 1 }
        : item)
      const outside = body.map((item, i) => i === 500
        ? { ...item, extra: 1 }
        : item)
      expect(diffAgainstSchema(items, inside).added).toEqual(['$[].extra'])
      expect(diffAgainstSchema(items, outside).added).toEqual([])
    })

    it('resolves a union nested in an array and in a map', () => {
      const union: JsonSchema = {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: {
              a: { type: 'integer' },
            },
            required: ['a'],
          },
        ],
      }
      const list: JsonSchema = { type: 'array', items: union }
      expect(diffAgainstSchema(list, [
        'x',
        { a: 1 },
      ])).toEqual({ added: [], removed: [], typeChanged: [] })
      expect(diffAgainstSchema(list, [
        'x',
        { a: 1 },
        {},
      ]).removed).toEqual(['$[].a'])
      expect(diffAgainstSchema(list, [1]).typeChanged).toEqual([
        { path: '$[]', expected: 'string', actual: 'integer' },
      ])
      const map: JsonSchema = { type: 'object', additionalProperties: union }
      expect(diffAgainstSchema(map, {
        'k@example.com': 'x',
        'j@example.com': { a: 1 },
      })).toEqual({ added: [], removed: [], typeChanged: [] })
      expect(diffAgainstSchema(map, { 'k@example.com': {} }).removed).toEqual(['$.*.a'])
    })

    it('reports a map value of the wrong type once, at .*', () => {
      const map: JsonSchema = {
        type: 'object',
        additionalProperties: { type: 'integer' },
      }
      expect(diffAgainstSchema(map, { a1: 'x', a2: 'y', a3: 3 }).typeChanged).toEqual([
        { path: '$.*', expected: 'integer', actual: 'string' },
      ])
    })
  })

  describe('redaction and order', () => {
    const open: JsonSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
    }
    const mask = (path: string): string => path.replace(/secret\w*/g, '[redacted]')

    it('redacts before deduplicating, so keys that redact alike appear once', () => {
      expect(diffAgainstSchema(open, { secretone: 1, secrettwo: 1 }, mask).added).toEqual(['$.[redacted]'])
    })

    it('sorts after redacting', () => {
      expect(diffAgainstSchema(open, { zeta: 1, secretalpha: 1, beta: 1 }, path => path.replace('secretalpha', 'aaa')).added).toEqual(['$.aaa', '$.beta', '$.zeta'])
    })

    it('sorts by code unit, not by locale: capitals first', () => {
      expect(diffAgainstSchema(open, { a: 1, B: 1, c: 1, Z: 1 }).added).toEqual(['$.B', '$.Z', '$.a', '$.c'])
    })
  })
})
