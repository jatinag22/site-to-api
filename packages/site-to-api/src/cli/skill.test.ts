import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packagedSkill, skillPathFor } from './skill'

let dir: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'site-to-api-skill-')))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A package installed the way pnpm does: the real folder in the store, a link to it. */
async function installed(): Promise<{ project: string, skill: string }> {
  const store = join(dir, 'project', 'node_modules', '.pnpm', 'site-to-api@1.0.0', 'node_modules', 'site-to-api')
  await mkdir(join(store, 'skills', 'site-to-api'), { recursive: true })
  await writeFile(join(store, 'skills', 'site-to-api', 'SKILL.md'), '# site-to-api\n')
  const project = join(dir, 'project')
  await symlink(store, join(project, 'node_modules', 'site-to-api'))
  return {
    project,
    skill: join(store, 'skills', 'site-to-api', 'SKILL.md'),
  }
}

describe('skillPathFor', () => {
  it('shows the project\'s node_modules path for the package it links to', async () => {
    const { project, skill } = await installed()
    expect(skillPathFor(skill, project, project)).toBe('node_modules/site-to-api/skills/site-to-api/SKILL.md')
  })

  it('shows the real path for a package the project does not link to (a global install)', async () => {
    const { skill } = await installed()
    const other = join(dir, 'other')
    await mkdir(other)
    expect(skillPathFor(skill, other, other)).toBe(skill)
  })
})

describe('packagedSkill', () => {
  it('finds the skill next to this package\'s package.json, once the build has copied it there', () => {
    const expected = fileURLToPath(new URL('../../skills/site-to-api/SKILL.md', import.meta.url))
    expect(packagedSkill()).toBe(existsSync(expected)
      ? expected
      : null)
  })
})
