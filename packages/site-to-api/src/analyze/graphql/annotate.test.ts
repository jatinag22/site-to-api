import { describe, expect, it } from 'vitest'
import { fakeHash, graphqlPost } from '../../../test/graphql'
import { exchange, jsonBody } from '../../../test/helpers'
import { annotateGraphql } from './annotate'

describe('annotateGraphql', () => {
  it('marks GraphQL exchanges and leaves the rest alone', () => {
    const rest = exchange({ url: 'https://api.example.test/api/items' })
    const graphql = graphqlPost({
      operationName: 'Q',
      variables: {},
      hash: fakeHash('2'),
    })
    const [first, second] = annotateGraphql([rest, graphql])
    expect(first).toBe(rest)
    expect(second?.graphql?.operationName).toBe('Q')
    expect(second?.id).toBe(graphql.id)
  })

  it('only looks at API traffic', () => {
    const page = {
      ...graphqlPost({ operationName: 'Q', variables: {} }),
      kind: 'page' as const,
    }
    expect(annotateGraphql([page])[0]?.graphql).toBeUndefined()
  })

  it('replaces a batch by one stand-in per element, with the matching response', () => {
    const batch = exchange({
      method: 'POST',
      url: 'https://api.example.test/graphql',
      requestBody: jsonBody([
        { operationName: 'A', variables: {}, query: 'query A { a }' },
        {
          operationName: 'B',
          variables: { x: 1 },
          query: 'query B { b }',
        },
      ]),
      responseBody: jsonBody([
        {
          data: { a: 1 },
        },
        {
          data: { b: 2 },
        },
      ]),
    })
    const split = annotateGraphql([batch])
    expect(split.map(item => item.id)).toEqual([`${batch.id}:graphql:0`, `${batch.id}:graphql:1`])
    expect(split[1]?.request.body?.json).toEqual({
      operationName: 'B',
      variables: { x: 1 },
      query: 'query B { b }',
    })
    expect(split[1]?.request.body?.text).toBe(JSON.stringify({
      operationName: 'B',
      variables: { x: 1 },
      query: 'query B { b }',
    }))
    expect(split[1]?.response.body?.json).toEqual({
      data: { b: 2 },
    })
    expect(split[1]?.graphql?.batchIndex).toBe(1)
  })

  it('keeps the whole response when it does not line up with the batch', () => {
    const batch = exchange({
      method: 'POST',
      url: 'https://api.example.test/graphql',
      requestBody: jsonBody([
        { query: '{ a }' },
        { query: '{ b }' },
      ]),
      responseBody: jsonBody({
        errors: [
          { message: 'batching disabled' },
        ],
      }),
    })
    expect(annotateGraphql([batch]).map(item => item.response.body?.json)).toEqual([
      {
        errors: [
          { message: 'batching disabled' },
        ],
      },
      {
        errors: [
          { message: 'batching disabled' },
        ],
      },
    ])
  })
})
