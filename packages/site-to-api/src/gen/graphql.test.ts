import type { GraphqlClientOperation, HostSpec } from './spec'
import { describe, expect, it } from 'vitest'
import { graphqlFunctions, renderGraphqlModule } from './graphql'

function operation(init: Partial<GraphqlClientOperation> = {}): GraphqlClientOperation {
  return {
    operationId: 'getAlbum',
    method: 'POST',
    path: '/graphql#getAlbum',
    endpoint: '/graphql',
    operationName: 'getAlbum',
    operationType: 'query',
    operationTypeFrom: 'source',
    persistedQuery: {
      version: 1,
      sha256Hash: 'a'.repeat(64),
    },
    document: null,
    batched: false,
    sent: {
      body: ['extensions', 'operationName', 'variables'],
      query: [],
    },
    variablesIn: 'body',
    variablesRequired: true,
    otherQuery: [],
    ...init,
  }
}

describe('renderGraphqlModule', () => {
  it('sends the constants in the body and routes a #name path to its endpoint', () => {
    const code = renderGraphqlModule([
      operation(),
    ])
    expect(code).toContain(`import { fetchWithoutFragment } from '@site-to-api/runtime'`)
    expect(code).toContain(`export type GetAlbumVariables = NonNullable<GetAlbumData['body']>['variables']`)
    expect(code).toContain(`  variables: GetAlbumVariables\n}`)
    expect(code).toContain(`    body: { operationName: "getAlbum", variables, extensions: { persistedQuery: { version: 1, sha256Hash: "${'a'.repeat(64)}" } } },`)
    expect(code).toContain('    fetch: fetchWithoutFragment(rest.fetch ?? (rest.client ?? client).getConfig().fetch),')
    expect(code).not.toContain('querySerializer')
  })

  it('takes other query parameters from the caller and encodes JSON fields for GET', () => {
    const code = renderGraphqlModule([
      operation({
        method: 'GET',
        path: `/api/v3/Header/${'b'.repeat(64)}`,
        sent: {
          body: [],
          query: ['extensions', 'operationName', 'variables'],
        },
        variablesIn: 'query',
        variablesRequired: false,
        otherQuery: [
          { name: 'locale', required: true },
          { name: 'page', required: false },
        ],
      }),
    ])
    expect(code).toContain(`  variables?: GetAlbumVariables\n  query: Omit<NonNullable<GetAlbumData['query']>, 'operationName' | 'query' | 'variables' | 'extensions'>\n}`)
    expect(code).toContain('    query: { ...query, operationName: "getAlbum", variables, extensions: ')
    expect(code).toContain('    querySerializer: graphqlQuerySerializer(["extensions","variables"]),')
    expect(code).not.toContain('fetchWithoutFragment')
    expect(code).not.toContain(`import { client }`)
  })

  it('sends the document and takes no variables when none were captured', () => {
    const code = renderGraphqlModule([
      operation({
        operationName: null,
        persistedQuery: null,
        document: '{ me { id } }',
        sent: {
          body: ['query'],
          query: [],
        },
        variablesIn: null,
        variablesRequired: false,
      }),
    ])
    expect(code).toContain('  const rest = options')
    expect(code).toContain('    body: { query: "{ me { id } }" },')
    expect(code).not.toContain('GetAlbumVariables')
  })
})

describe('graphqlFunctions', () => {
  it('leaves out operations whose SDK function is not a plain identifier, with a warning', () => {
    const warnings: string[] = []
    const host: Pick<HostSpec, 'file' | 'graphql'> = {
      file: 'a.yaml',
      graphql: [
        operation(),
        operation({ operationId: '1-2' }),
      ],
    }
    expect(graphqlFunctions(host, warnings).map(item => item.operationId)).toEqual(['getAlbum'])
    expect(warnings).toHaveLength(1)
  })
})
