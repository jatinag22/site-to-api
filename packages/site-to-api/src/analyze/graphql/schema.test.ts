import type { Exchange, Operation } from '../../model'
import { describe, expect, it } from 'vitest'
import { fakeHash, graphqlGet, graphqlPost } from '../../../test/graphql'
import { exchange, jsonBody } from '../../../test/helpers'
import { buildOperations } from '../operations'
import { createRedactor } from '../redact'
import { inferOperationSchemas } from '../schema'
import { annotateGraphql } from './annotate'

const HASH = fakeHash('c3')

function analyse(exchanges: Exchange[]): Operation[] {
  const annotated = annotateGraphql(exchanges)
  const redactor = createRedactor({
    exchanges: annotated,
    config: {
      examples: 'masked',
      maxExamples: 3,
      patterns: [],
      fields: [],
    },
  })
  return inferOperationSchemas(buildOperations(annotated, { sourceRoutes: [] }), redactor)
}

describe('graphQL request schemas', () => {
  it('pins the operation name and persisted hash in a JSON body and keeps variables typed', () => {
    const [operation] = analyse([
      graphqlPost({
        operationName: 'queryArtistOverview',
        variables: { uri: 'spotify:artist:1', locale: '' },
        hash: HASH,
      }),
      graphqlPost({
        operationName: 'queryArtistOverview',
        variables: { uri: 'spotify:artist:2', locale: 'en' },
        hash: HASH,
        sessionId: 's2',
      }),
    ])
    const schema = operation?.requestBody?.schema
    expect(schema?.properties?.operationName).toEqual({ type: 'string', const: 'queryArtistOverview', default: 'queryArtistOverview' })
    expect(schema?.properties?.extensions).toEqual({
      type: 'object',
      properties: {
        persistedQuery: {
          type: 'object',
          properties: {
            version: { type: 'integer', const: 1, default: 1 },
            sha256Hash: { type: 'string', const: HASH, default: HASH },
          },
          required: ['version', 'sha256Hash'],
        },
      },
      required: ['persistedQuery'],
    })
    expect(schema?.properties?.variables?.properties?.uri?.type).toBe('string')
    expect(schema?.properties?.variables?.required).toEqual(['uri', 'locale'])
    expect(schema?.required).toEqual(['operationName', 'variables', 'extensions'])
  })

  it('pins the document and leaves site-specific body fields optional', () => {
    const [operation] = analyse([
      exchange({
        method: 'POST',
        url: 'https://api.example.test/graphql',
        requestBody: jsonBody({
          query: 'mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }',
          variables: { id: '1' },
          clientName: 'web',
        }),
        responseBody: jsonBody({
          data: {
            addToCart: { ok: true },
          },
        }),
      }),
    ])
    const schema = operation?.requestBody?.schema
    expect(schema?.properties?.query).toEqual({
      type: 'string',
      const: 'mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }',
      default: 'mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }',
    })
    expect(schema?.properties?.clientName).toBeDefined()
    expect(schema?.required).toEqual(['query', 'variables'])
    expect(operation?.graphql?.document).toBe('mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }')
  })

  it('redacts personal data written inline in a document', () => {
    const [operation] = analyse([
      graphqlPost({ query: '{ user(email: "jane.doe@example.com") { id } }' }),
    ])
    expect(operation?.graphql?.document).not.toContain('jane.doe@example.com')
    expect(operation?.requestBody?.schema.properties?.query?.const).toBe(operation?.graphql?.document)
  })

  it('decodes GET variables and extensions into typed JSON parameters', () => {
    const [operation] = analyse([
      graphqlGet({
        operationName: 'StoreHours',
        variables: { slug: 'pine-hill', days: 7 },
        hash: HASH,
        extraQuery: { locale: 'en' },
      }),
      graphqlGet({
        operationName: 'StoreHours',
        variables: { slug: 'cedar-park', days: 7 },
        hash: HASH,
        extraQuery: { locale: 'en' },
        sessionId: 's2',
      }),
    ])
    const byName = new Map(operation?.query.map(param => [param.name, param]))
    expect(byName.get('variables')).toMatchObject({
      json: true,
      required: true,
      schema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          days: { type: 'integer' },
        },
        required: ['slug', 'days'],
      },
    })
    expect(byName.get('extensions')?.json).toBe(true)
    expect(byName.get('extensions')?.schema.properties?.persistedQuery?.properties?.sha256Hash?.const).toBe(HASH)
    expect(byName.get('operationName')?.schema).toEqual({ type: 'string', const: 'StoreHours', default: 'StoreHours' })
    expect(byName.get('locale')?.json).toBeUndefined()
  })

  it('leaves JSON-looking query values of other operations as strings', () => {
    const [operation] = analyse([
      exchange({
        url: `https://shop.test/api/search?filter=${encodeURIComponent('{"a":1}')}`,
        responseBody: jsonBody({ items: [] }),
      }),
    ])
    expect(operation?.query[0]).toMatchObject({
      name: 'filter',
      schema: { type: 'string' },
    })
    expect(operation?.query[0]?.json).toBeUndefined()
  })
})
