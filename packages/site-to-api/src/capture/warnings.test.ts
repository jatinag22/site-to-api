import { describe, expect, it } from 'vitest'
import { WarningLog } from './warnings'

describe('warningLog', () => {
  it('says a repeated problem once with a count, and a single one in full', () => {
    const log = new WarningLog()
    const invalid = (url: string): void => log.addGrouped('invalid-json', url, `Sourcemap ${url} is not valid sourcemap JSON.`, (count, first) => `${count} sourcemaps are not valid sourcemap JSON (first: ${first}).`)
    for (const name of ['a', 'b', 'c'])
      invalid(`https://shop.test/${name}.js.map`)
    log.addGrouped('http:404', 'https://shop.test/x.map', 'Sourcemap https://shop.test/x.map returned HTTP 404.', count => `${count} sourcemaps returned HTTP 404.`)
    log.add('Could not save script https://shop.test/big.js: too large')
    expect(log.list()).toEqual([
      'Could not save script https://shop.test/big.js: too large',
      '3 sourcemaps are not valid sourcemap JSON (first: https://shop.test/a.js.map).',
      'Sourcemap https://shop.test/x.map returned HTTP 404.',
    ])
  })
})
