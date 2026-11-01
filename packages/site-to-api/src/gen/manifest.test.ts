import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { syncGenerated } from './manifest'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-manifest-'))
  dirs.push(dir)
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await writeFile(path.join(dir, file), text)
  }
  return dir
}

describe('syncGenerated', () => {
  it('writes generated files, keeps the person\'s own files, and records hashes', async () => {
    const target = await folder({ 'notes.md': 'mine' })
    const first = await syncGenerated(await folder({ 'index.ts': 'v1', 'shop/sdk.gen.ts': 's1' }), target, null, false)
    expect(Object.keys(first.manifest)).toEqual(['index.ts', 'shop/sdk.gen.ts'])
    expect(await readFile(path.join(target, 'notes.md'), 'utf8')).toBe('mine')
    expect(first.warnings).toEqual([])
  })

  it('keeps a generated file edited by hand and warns, unless forced', async () => {
    const target = await folder({})
    const first = await syncGenerated(await folder({ 'index.ts': 'v1' }), target, null, false)
    await writeFile(path.join(target, 'index.ts'), 'v1 + my edit')
    const second = await syncGenerated(await folder({ 'index.ts': 'v2' }), target, first.manifest, false)
    expect(await readFile(path.join(target, 'index.ts'), 'utf8')).toBe('v1 + my edit')
    expect(second.warnings[0]).toContain('Kept 1 client file(s) edited by hand')
    expect(second.warnings[0]).toContain('site-to-api gen --force')
    const forced = await syncGenerated(await folder({ 'index.ts': 'v2' }), target, second.manifest, true)
    expect(await readFile(path.join(target, 'index.ts'), 'utf8')).toBe('v2')
    expect(forced.warnings).toEqual([])
  })

  it('deletes only generated files that are no longer generated, and only when unchanged', async () => {
    const target = await folder({ 'mine.ts': 'x' })
    const first = await syncGenerated(await folder({ 'old/sdk.gen.ts': 'o', 'gone.ts': 'g', 'index.ts': 'v1' }), target, null, false)
    await writeFile(path.join(target, 'gone.ts'), 'g + edit')
    const second = await syncGenerated(await folder({ 'index.ts': 'v2' }), target, first.manifest, false)
    expect(existsSync(path.join(target, 'old'))).toBe(false)
    expect(existsSync(path.join(target, 'gone.ts'))).toBe(true)
    expect(existsSync(path.join(target, 'mine.ts'))).toBe(true)
    expect(second.warnings[0]).toContain('gone.ts')
  })

  it('does not overwrite a file at a generated path it never wrote', async () => {
    const target = await folder({ 'extract.ts': 'my own extract' })
    const result = await syncGenerated(await folder({ 'extract.ts': 'generated' }), target, {}, false)
    expect(await readFile(path.join(target, 'extract.ts'), 'utf8')).toBe('my own extract')
    expect(result.warnings[0]).toContain('Did not overwrite 1 file(s)')
  })
})
