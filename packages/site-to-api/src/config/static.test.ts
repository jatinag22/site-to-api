import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { staticConfigValue } from './static'

const dirs: string[] = []

async function config(text: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-static-'))
  dirs.push(dir)
  const file = path.join(dir, 'site-to-api.config.ts')
  await writeFile(file, text)
  return file
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('staticConfigValue', () => {
  it('reads a top-level string literal without running the file', async () => {
    const file = await config(`import { defineConfig } from 'site-to-api'\nthrow new Error('never run')\nexport default defineConfig({\n  rawDir: '.raw',\n  outDir: 'src/api/shop',\n  gen: { outDir: 'nested' },\n})\n`)
    expect(await staticConfigValue(file, 'outDir')).toBe('src/api/shop')
  })

  it('gives null for a computed value, a missing key or two candidates', async () => {
    expect(await staticConfigValue(await config(`export default { outDir: process.env.DIR }\n`), 'outDir')).toBeNull()
    expect(await staticConfigValue(await config(`export default { rawDir: 'x' }\n`), 'outDir')).toBeNull()
    expect(await staticConfigValue(await config(`const a = { outDir: 'a' }\nexport default { outDir: 'b' }\n`), 'outDir')).toBeNull()
  })
})
