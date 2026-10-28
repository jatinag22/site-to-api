import type { GraphqlExchange } from './operation'
import { describe, expect, it } from 'vitest'
import { fakeHash, graphqlPost } from '../../../test/graphql'
import { annotateGraphql } from './annotate'
import { graphqlOperationOf, graphqlSpecPath, isGraphqlExchange } from './operation'

function annotated(...exchanges: Parameters<typeof graphqlPost>[0][]): [GraphqlExchange, ...GraphqlExchange[]] {
  const [first, ...rest] = annotateGraphql(exchanges.map(graphqlPost)).filter(isGraphqlExchange)
  if (!first)
    throw new Error('no GraphQL exchange')
  return [first, ...rest]
}

describe('graphqlOperationOf', () => {
  it('leaves the type unknown when documents disagree, and keeps only the fields every sample sent', () => {
    const operation = graphqlOperationOf(annotated(
      {
        operationName: 'Op',
        query: 'query Op { a }',
        variables: {},
        startedAt: 1,
      },
      { operationName: 'Op', query: 'mutation Op { a }', startedAt: 2 },
    ))
    expect(operation.operationType).toBe('unknown')
    expect(operation.operationTypeFrom).toBeNull()
    expect(operation.sent.body).toEqual(['operationName', 'query'])
    expect(operation.document).toBe('mutation Op { a }')
  })

  it('takes the endpoint and persisted query of the most recent sample', () => {
    const operation = graphqlOperationOf(annotated(
      {
        path: '/v2/graphql',
        operationName: 'Op',
        variables: {},
        hash: fakeHash('2'),
        startedAt: 20,
      },
      {
        path: '/v1/graphql',
        operationName: 'Op',
        variables: {},
        hash: fakeHash('1'),
        startedAt: 10,
      },
    ))
    expect(operation.endpoint).toBe('/v2/graphql')
    expect(operation.persistedQuery?.sha256Hash).toBe(fakeHash('2'))
    expect(operation.hashes).toEqual([
      fakeHash('1'),
      fakeHash('2'),
    ])
  })
})

describe('graphqlSpecPath', () => {
  it('labels anonymous operations by their key', () => {
    const operation = graphqlOperationOf(annotated({
      hash: fakeHash('3'),
    }))
    expect(graphqlSpecPath(operation, `sha256:${fakeHash('3')}`, false)).toBe(`/graphql#persisted-${fakeHash('3').slice(0, 12)}`)
    expect(graphqlSpecPath(operation, 'document:0123456789abcdef', false)).toBe('/graphql#document-0123456789ab')
    expect(graphqlSpecPath(operation, 'x', true)).toBe('/graphql')
  })
})
