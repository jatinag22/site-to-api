import type { Operation } from '../../model'
import { describe, expect, it } from 'vitest'
import { fakeHash, graphqlPost } from '../../../test/graphql'
import { buildOperations } from '../operations'
import { annotateGraphql } from './annotate'
import { applyGraphqlTypes, graphqlTypesInText, graphqlTypeTargets } from './evidence'

const SHARED = fakeHash('d4')
const OWN = fakeHash('e5')

describe('graphqlTypesInText', () => {
  it('reads the type next to the persisted hash, and only when the name is beside it', () => {
    // One document, three operations, one hash: the name tells them apart (Spotify-style).
    const bundle = `let c=new l.l("recentSearches","query","${SHARED}",null),d=new l.l("saveRecentSearches","mutation","${SHARED}",null),p=new l.l("removeRecentSearches","mutation","${SHARED}",null);`
    const found = graphqlTypesInText(bundle, [
      {
        key: 'h recentSearches',
        operationName: 'recentSearches',
        hashes: [SHARED],
      },
      {
        key: 'h saveRecentSearches',
        operationName: 'saveRecentSearches',
        hashes: [SHARED],
      },
    ])
    expect(found.get('h recentSearches')).toEqual(['query'])
    expect(found.get('h saveRecentSearches')).toEqual(['mutation'])
  })

  it('reads object-literal definitions, documents and compiled documents', () => {
    const text = [
      `e.LocationQuery={name:'LocationQuery',type:'query',operationId:'${OWN}'};`,
      'const doc = "mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }";',
      'var D={kind:"Document",definitions:[{kind:"OperationDefinition",operation:"subscription",name:{kind:"Name",value:"OnTick"}}]};',
    ].join('\n')
    const found = graphqlTypesInText(text, [
      {
        key: 'a',
        operationName: 'LocationQuery',
        hashes: [OWN],
      },
      { key: 'b', operationName: 'AddToCart', hashes: [] },
      { key: 'c', operationName: 'OnTick', hashes: [] },
      {
        key: 'd',
        operationName: 'Missing',
        hashes: [
          fakeHash('f6'),
        ],
      },
    ])
    expect(Object.fromEntries(found)).toEqual({
      a: ['query'],
      b: ['mutation'],
      c: ['subscription'],
    })
  })

  it('takes a type near an anonymous hash without asking for a name', () => {
    expect(graphqlTypesInText(`register("query", "${OWN}")`, [
      {
        key: 'k',
        operationName: null,
        hashes: [OWN],
      },
    ]).get('k')).toEqual(['query'])
  })
})

describe('applyGraphqlTypes', () => {
  function unknownOperation(): Operation[] {
    return buildOperations(annotateGraphql([
      graphqlPost({ operationName: 'getAlbum', variables: {}, hash: OWN }),
    ]), { sourceRoutes: [] })
  }

  it('sets the type the code agrees on and says where it came from', () => {
    const operations = unknownOperation()
    expect(graphqlTypeTargets(operations)).toEqual([
      {
        key: 'api.example.test getAlbum',
        operationName: 'getAlbum',
        hashes: [OWN],
      },
    ])
    const [typed] = applyGraphqlTypes(operations, new Map([
      [
        'api.example.test getAlbum',
        ['query', 'query'],
      ],
    ]))
    expect(typed?.graphql).toMatchObject({ operationType: 'query', operationTypeFrom: 'source' })
    expect(typed?.summary).toMatch(/^GraphQL query getAlbum /)
  })

  it('keeps unknown when the code disagrees with itself', () => {
    const [typed] = applyGraphqlTypes(unknownOperation(), new Map([
      [
        'api.example.test getAlbum',
        ['query', 'mutation'],
      ],
    ]))
    expect(typed?.graphql).toMatchObject({ operationType: 'unknown', operationTypeFrom: null })
  })
})
