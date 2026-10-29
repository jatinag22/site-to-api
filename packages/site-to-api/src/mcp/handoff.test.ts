import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeShopHandoff } from '../../test/handoff'
import { loadHandoff, readExcerpt } from './handoff'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A shop folder, and a Markdown file outside it that must never be served. */
async function folders(): Promise<{ dir: string, outside: string }> {
  const dir = await writeShopHandoff()
  const outside = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-outside-'))
  dirs.push(dir, outside)
  await mkdir(path.join(outside, 'deep'), { recursive: true })
  await writeFile(path.join(outside, 'deep', 'notes.md'), 'private notes\n')
  return { dir, outside }
}

describe('excerpts', () => {
  it('lists the Markdown files under source/', async () => {
    const { dir } = await folders()
    expect((await loadHandoff(dir)).excerpts).toEqual(['source/src/auth/crypto.L18-28.ts.md'])
  })

  it('serves nothing when source/ itself is a symbolic link', async () => {
    const { dir, outside } = await folders()
    await rm(path.join(dir, 'source'), { recursive: true })
    await symlink(outside, path.join(dir, 'source'))
    const handoff = await loadHandoff(dir)
    expect(handoff.excerpts).toEqual([])
    expect(handoff.warnings.join('\n')).toContain('is a symbolic link')
  })

  it('skips links inside source/ that lead out of it, to folders or to files', async () => {
    const { dir, outside } = await folders()
    await symlink(outside, path.join(dir, 'source', 'sub'))
    await symlink(path.join(outside, 'deep', 'notes.md'), path.join(dir, 'source', 'notes.md'))
    // A link that stays inside source/ is fine.
    await symlink(path.join(dir, 'source', 'src', 'auth', 'crypto.L18-28.ts.md'), path.join(dir, 'source', 'alias.md'))
    const handoff = await loadHandoff(dir)
    expect(handoff.excerpts).toEqual(['source/alias.md', 'source/src/auth/crypto.L18-28.ts.md'])
    expect(await readExcerpt(handoff, 'source/sub/deep/notes.md')).toBeNull()
  })

  it('checks again when reading, in case source/ was swapped after it was listed', async () => {
    const { dir, outside } = await folders()
    const handoff = await loadHandoff(dir)
    await rename(path.join(dir, 'source'), path.join(dir, 'source-old'))
    await mkdir(path.join(outside, 'src', 'auth'), { recursive: true })
    await writeFile(path.join(outside, 'src', 'auth', 'crypto.L18-28.ts.md'), 'private\n')
    await symlink(outside, path.join(dir, 'source'))
    expect(await readExcerpt(handoff, 'source/src/auth/crypto.L18-28.ts.md')).toBeNull()
  })
})
