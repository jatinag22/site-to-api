import { describe, expect, it } from 'vitest'
import { fetchWithoutFragment, graphqlQuerySerializer, withoutFragment } from './graphql'

describe('withoutFragment', () => {
  it('drops the fragment and moves a query string hey-api put after it', () => {
    expect(withoutFragment('https://h.test/graphql#getUser')).toBe('https://h.test/graphql')
    expect(withoutFragment('https://h.test/graphql#getUser?a=1&b=2')).toBe('https://h.test/graphql?a=1&b=2')
    expect(withoutFragment('https://h.test/graphql?x=0#getUser?a=1')).toBe('https://h.test/graphql?x=0&a=1')
    expect(withoutFragment('https://h.test/graphql#getUser?')).toBe('https://h.test/graphql')
    expect(withoutFragment('https://h.test/graphql?a=1')).toBe('https://h.test/graphql?a=1')
  })
})

describe('fetchWithoutFragment', () => {
  it('sends the request to the endpoint with its method, headers and body', async () => {
    const seen: Array<{ url: string, method: string, header: string | null, body: string }> = []
    const send = fetchWithoutFragment(async (input, init) => {
      const request = new Request(input, init)
      seen.push({
        url: request.url,
        method: request.method,
        header: request.headers.get('x-test'),
        body: await request.text(),
      })
      return new Response('{}')
    })
    await send(new Request('https://h.test/graphql#addUser?locale=en', {
      method: 'POST',
      headers: { 'x-test': '1' },
      body: '{"a":1}',
    }))
    await send('https://h.test/graphql?a=1')
    expect(seen).toEqual([
      {
        url: 'https://h.test/graphql?locale=en',
        method: 'POST',
        header: '1',
        body: '{"a":1}',
      },
      {
        url: 'https://h.test/graphql?a=1',
        method: 'GET',
        header: null,
        body: '',
      },
    ])
  })
})

describe('graphqlQuerySerializer', () => {
  it('writes the named fields as JSON and everything else as itself, in order', () => {
    const serialize = graphqlQuerySerializer(['variables', 'extensions'])
    const text = serialize({
      operationName: 'StoreHours',
      locale: 'en',
      tag: ['a', 'b'],
      empty: undefined,
      page: 2,
      variables: {
        slug: 'pine-hill',
        ids: [1, 2],
      },
      extensions: {
        persistedQuery: { version: 1, sha256Hash: 'abc' },
      },
    })
    const params = new URLSearchParams(text)
    expect([
      ...params.keys(),
    ]).toEqual([
      'operationName',
      'locale',
      'tag',
      'tag',
      'page',
      'variables',
      'extensions',
    ])
    expect(params.getAll('tag')).toEqual(['a', 'b'])
    expect(JSON.parse(params.get('variables') ?? '')).toEqual({
      slug: 'pine-hill',
      ids: [1, 2],
    })
    expect(JSON.parse(params.get('extensions') ?? '')).toEqual({
      persistedQuery: { version: 1, sha256Hash: 'abc' },
    })
  })
})
