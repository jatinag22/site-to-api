import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isFolderRelative } from './contained'
import { removeGenerated, syncGenerated } from './manifest'

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
    // Written through a temporary file and a rename in the same folder; none is left behind.
    expect((await readdir(target, { recursive: true })).filter(name => name.endsWith('.tmp'))).toEqual([])
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

describe('paths recorded in build.json and symbolic links (decision 0058)', () => {
  const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

  it('never deletes a recorded path outside the folder, with or without --force', async () => {
    const root = await folder({ 'secret.env': 'TOKEN=abc', 'proj/api-handoff/client/keep.md': 'k' })
    const client = path.join(root, 'proj', 'api-handoff', 'client')
    for (const force of [true, false]) {
      const result = await removeGenerated(client, {
        '../../../secret.env': hash('TOKEN=abc'),
        '/etc/hosts': 'x',
      }, force)
      expect(await readFile(path.join(root, 'secret.env'), 'utf8')).toBe('TOKEN=abc')
      expect(result.warnings.join('\n')).toContain('../../../secret.env is not a path inside the folder')
    }
  })

  it('never writes or deletes through a symbolic link, in legacy mode or with --force', async () => {
    const root = await folder({ 'victim.txt': 'mine', 'client/keep.md': 'k', 'elsewhere/x.ts': 'theirs' })
    const client = path.join(root, 'client')
    await symlink(path.join(root, 'victim.txt'), path.join(client, 'index.ts'))
    await symlink(path.join(root, 'elsewhere'), path.join(client, 'shop'))
    const staging = await folder({ 'index.ts': 'generated', 'shop/x.ts': 'generated' })
    for (const [previous, force] of [
      [null, false],
      [{}, true],
    ] as const) {
      const result = await syncGenerated(staging, client, previous, force)
      expect(await readFile(path.join(root, 'victim.txt'), 'utf8')).toBe('mine')
      expect(await readFile(path.join(root, 'elsewhere', 'x.ts'), 'utf8')).toBe('theirs')
      expect(result.warnings.join('\n')).toContain('index.ts is a symbolic link')
      expect(result.warnings.join('\n')).toContain('shop/x.ts is reached through a symbolic link')
      expect(result.manifest).toEqual({})
    }
    await removeGenerated(client, {
      'index.ts': hash('mine'),
      'shop/x.ts': hash('theirs'),
    }, true)
    expect(existsSync(path.join(root, 'victim.txt'))).toBe(true)
    expect(existsSync(path.join(root, 'elsewhere', 'x.ts'))).toBe(true)
  })

  it('accepts only relative paths inside the folder', () => {
    expect(['index.ts', 'shop/sdk.gen.ts'].every(isFolderRelative)).toBe(true)
    expect([
      '../x',
      'a/../b',
      '/etc/x',
      'C:/x',
      'a\\b',
      'a//b',
      './a',
      '',
    ].some(isFolderRelative)).toBe(false)
  })
})
