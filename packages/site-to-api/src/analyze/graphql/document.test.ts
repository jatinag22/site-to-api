import { describe, expect, it } from 'vitest'
import { normalizeDocument, readOperations, readVariables, selectOperation } from './document'

describe('readOperations', () => {
  it('reads named and anonymous operations and skips fragments', () => {
    expect(readOperations(`
      # a comment with { braces }
      query Product($id: ID!, $filter: Filter = { inStock: true }) @cached {
        product(id: $id) { ...Fields name(format: "x}") }
      }
      fragment Fields on Product { id }
      mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }
      subscription { ticks }
      { me { id } }
    `)).toEqual([
      { type: 'query', name: 'Product' },
      { type: 'mutation', name: 'AddToCart' },
      { type: 'subscription', name: null },
      { type: 'query', name: null },
    ])
  })

  it('reads block strings with escaped quotes', () => {
    expect(readOperations('query Q { a(text: """say \\""" hi""") }')).toEqual([
      { type: 'query', name: 'Q' },
    ])
  })

  it('rejects text that is not a document, such as a search term in a `query` field', () => {
    expect(readOperations('red shoes')).toBeNull()
    expect(readOperations('query')).toBeNull()
    expect(readOperations('query Q { a ')).toBeNull()
    expect(readOperations('query Q { a ) }')).toBeNull()
    expect(readOperations('fragment F on T { a }')).toBeNull()
    expect(readOperations('')).toBeNull()
    expect(readOperations('{ a(x: "unterminated) }')).toBeNull()
    expect(readOperations('query Q { a } ; ')).toBeNull()
  })

  it('rejects JSON objects sent in a `query` field', () => {
    expect(readOperations('{"status":"active","limit":10}')).toBeNull()
    expect(readOperations('{}')).toBeNull()
    expect(readOperations('{"$and":[{"a":1}]}')).toBeNull()
    expect(readOperations('{"name":"x"}')).toBeNull()
    expect(readOperations('{ status: "old" }')).toBeNull()
    expect(readOperations('{ a { } }')).toBeNull()
    expect(readOperations('{ 1 }')).toBeNull()
    expect(readOperations('query Q { : a }')).toBeNull()
  })

  it('still accepts strings, numbers, lists and object values inside arguments', () => {
    expect(readOperations('{ items(filter: { status: "old", ids: [1, 2] }, first: 10) { id alias: name } }')).toEqual([
      { type: 'query', name: null },
    ])
    expect(readOperations('query Q($ids: [ID!]! = []) { a(o: {}) { ...F } }')).toEqual([
      { type: 'query', name: 'Q' },
    ])
  })
})

describe('selectOperation', () => {
  const operations = [
    { type: 'query' as const, name: 'A' },
    { type: 'mutation' as const, name: 'B' },
  ]

  it('picks the named operation, or the only one', () => {
    expect(selectOperation(operations, 'B')).toEqual({ type: 'mutation', name: 'B' })
    expect(selectOperation(operations, 'C')).toBeNull()
    expect(selectOperation(operations, null)).toBeNull()
    expect(selectOperation([
      { type: 'query', name: null },
    ], null)).toEqual({ type: 'query', name: null })
  })
})

describe('normalizeDocument', () => {
  it('ignores layout and comments, keeps string contents', () => {
    expect(normalizeDocument('query Q {\n  a # note\n  b(x: "a  b")\n}')).toBe('query Q { a b ( x : "a  b" ) }')
    expect(normalizeDocument('query Q{a b(x:"a  b")}')).toBe(normalizeDocument('query Q {\n  a\n  b(x: "a  b")\n}'))
    expect(normalizeDocument('%')).toBeNull()
  })
})

describe('readVariables', () => {
  it('says which variables are declared non-null at the top level, without a default', () => {
    const variables = readVariables('query Q($id: Int!, $note: String, $ids: [ID!], $tags: [String]! = [], $at: Date @deprecated) { a }', null)
    expect(Object.fromEntries(variables ?? [])).toEqual({
      id: true,
      note: false,
      ids: false,
      tags: false,
      at: false,
    })
  })

  it('does not require a non-null variable with a default', () => {
    const variables = readVariables('query Q($first: Int! = 20, $after: String = "x", $id: ID!, $ids: [ID!]! = []) { a }', null)
    expect(Object.fromEntries(variables ?? [])).toEqual({
      first: false,
      after: false,
      id: true,
      ids: false,
    })
  })

  it('reads the operation the request names, and nothing for an operation without variables', () => {
    const document = 'query A($a: Int!) { a } mutation B($b: Int) { b } query C { c }'
    expect(Object.fromEntries(readVariables(document, 'B') ?? [])).toEqual({ b: false })
    expect(readVariables(document, 'C')?.size).toBe(0)
    expect(readVariables(document, null)).toBeNull()
    expect(readVariables('{"id":1}', null)).toBeNull()
  })
})
