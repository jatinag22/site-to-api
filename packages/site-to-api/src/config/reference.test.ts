import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { configurationReference, referenceEntries } from './reference'

const SCHEMA = fileURLToPath(new URL('./schema.ts', import.meta.url))
const DOC = fileURLToPath(new URL('../../../../docs/configuration.md', import.meta.url))

describe('configuration reference', () => {
  it('describes every key of the schema', async () => {
    const missing = referenceEntries(await readFile(SCHEMA, 'utf8'))
      .filter(entry => entry.description === '')
      .map(entry => entry.path.join('.'))
    expect(missing, 'add a JSDoc comment to these keys in src/config/schema.ts').toEqual([])
  })

  it('matches docs/configuration.md (regenerate with UPDATE_CONFIG_DOC=1 when the schema changes)', async () => {
    const generated = configurationReference(await readFile(SCHEMA, 'utf8'))
    if (process.env.UPDATE_CONFIG_DOC === '1')
      await writeFile(DOC, generated)
    const committed = existsSync(DOC)
      ? await readFile(DOC, 'utf8')
      : ''
    expect(committed, 'docs/configuration.md is out of date: run UPDATE_CONFIG_DOC=1 pnpm exec vitest --run packages/site-to-api/src/config/reference.test.ts').toBe(generated)
  })
})
