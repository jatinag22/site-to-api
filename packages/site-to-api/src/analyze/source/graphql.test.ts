import { afterAll, describe, expect, it } from 'vitest'
import { removeSessions, writeSession } from '../../../test/sessions'
import { findGraphqlTypes } from './index'

afterAll(removeSessions)

const HASH = 'f'.repeat(64)

describe('findGraphqlTypes', () => {
  it('reads every session\'s site code once per distinct file and collects the types it states', async () => {
    const bundle = `const q=new P("getAlbum","query","${HASH}",null);`
    const first = await writeSession('s1', [
      { url: 'https://shop.test/app.js', file: 'scripts/app.js', content: bundle },
    ])
    const second = await writeSession('s2', [
      { url: 'https://shop.test/app.js', file: 'scripts/app.js', content: bundle },
    ])
    const found = await findGraphqlTypes([first, second], [
      {
        key: 'shop.test getAlbum',
        operationName: 'getAlbum',
        hashes: [HASH],
      },
      { key: 'shop.test other', operationName: 'other', hashes: [] },
    ])
    expect(Object.fromEntries(found)).toEqual({
      'shop.test getAlbum': ['query'],
    })
  })

  it('reads nothing when no operation needs a type', async () => {
    expect((await findGraphqlTypes([], [])).size).toBe(0)
  })
})
