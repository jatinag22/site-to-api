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
})
