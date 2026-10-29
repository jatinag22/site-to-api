import { afterAll, describe, expect, it } from 'vitest'
import { removeSessions, writeSession } from '../../../test/sessions'
import { collectStaticStrings } from './index'

afterAll(removeSessions)

describe('collectStaticStrings', () => {
  it('collects literals of six or more characters from site code only', async () => {
    const session = await writeSession('s1', [
      {
        url: 'https://shop.test/main.js',
        file: 'scripts/main.js',
        content: '',
        sourceMap: {
          url: 'https://shop.test/main.js.map',
          file: 'maps/main.js.map',
          map: {},
          sources: {
            'sources/shop.test/src/config.ts': `export const KEY = "demo-public-key-0123"\nconst short = "abc"\nconst t = \`client-web-1\`\nconst d = \`\${KEY}-suffix\`\nconst n = 1234567`,
            'sources/shop.test/node_modules/lib/x.js': 'const libraryOnly = "library-constant"',
          },
        },
      },
      { url: 'https://shop.test/inline.js', file: 'scripts/inline.js', content: 'var a="bundle-salt-value",b=\'xy\'' },
    ])
    const strings = await collectStaticStrings([session])
    expect([...strings].sort()).toEqual(['bundle-salt-value', 'client-web-1', 'demo-public-key-0123'])
  })

  it('collects shorter items of a list of string literals, the options a page offers', async () => {
    const session = await writeSession('s1', [
      { url: 'https://shop.test/chain.js', file: 'scripts/chain.js', content: 'var indices=["NIFTY","FINNIFTY","BANK"],pair=["abc","USD"],mixed=["EURO",x],word="NIFTY50"' },
    ])
    expect([
      ...await collectStaticStrings([session]),
    ].sort()).toEqual(['BANK', 'FINNIFTY', 'NIFTY', 'NIFTY50'])
  })

  it('skips strings longer than 1,024 characters', async () => {
    const session = await writeSession('s1', [
      { url: 'https://shop.test/a.js', file: 'scripts/a.js', content: `var a="${'x'.repeat(2000)}",b="normal-value"` },
    ])
    expect([
      ...await collectStaticStrings([session]),
    ]).toEqual(['normal-value'])
  })
})
