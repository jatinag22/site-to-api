import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { isOlderVersion, packagedSkill, readSkillCopy, skillPathFor, staleSkillNotice, stampSkill } from './skill'

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

const SKILL = '---\nname: site-to-api\ndescription: Wrap a site.\n---\n\n# site-to-api\n'

/** The YAML between a skill's `---` lines. */
function frontmatter(skill: string): unknown {
  return parse(skill.slice(4, skill.indexOf('\n---\n', 3)))
}

describe('stampSkill and readSkillCopy', () => {
  it('records the version as the frontmatter\'s last field and reads it back as unedited', () => {
    const stamped = stampSkill(SKILL, '0.2.0')
    expect(stamped).toMatch(/^---\nname: site-to-api\ndescription: Wrap a site\.\nmetadata:\n {2}site-to-api-version: "0\.2\.0"\n {2}site-to-api-sha256: "[0-9a-f]{64}"\n---\n\n# site-to-api\n$/)
    expect(readSkillCopy(stamped)).toEqual({ stamped: true, version: '0.2.0', edited: false })
  })

  it('tells an edit anywhere in the copy, frontmatter included', () => {
    const stamped = stampSkill(SKILL, '0.2.0')
    expect(readSkillCopy(`${stamped}\nOur own rule.\n`)).toEqual({ stamped: true, version: '0.2.0', edited: true })
    expect(readSkillCopy(stamped.replace('Wrap a site.', 'Wrap our site.'))).toEqual({ stamped: true, version: '0.2.0', edited: true })
  })

  it('finds no stamp in a skill copied some other way', () => {
    expect(readSkillCopy(SKILL)).toEqual({ stamped: false })
    expect(readSkillCopy('# no frontmatter\n')).toEqual({ stamped: false })
  })

  it('refuses a skill it cannot stamp without breaking its frontmatter', () => {
    expect(() => stampSkill('# site-to-api\n', '0.2.0')).toThrow('without frontmatter')
    expect(() => stampSkill('---\nname: x\nmetadata:\n  a: b\n---\n', '0.2.0')).toThrow('`metadata` field')
  })

  it('keeps the repository\'s skill valid for Agent Skills loaders: fields intact, metadata a map of strings', async () => {
    const source = await readFile(fileURLToPath(new URL('../../../../skills/site-to-api/SKILL.md', import.meta.url)), 'utf8')
    const stamped = stampSkill(source, '1.2.3-beta.0')
    const original = frontmatter(source)
    expect(original).toBeTypeOf('object')
    expect(frontmatter(stamped)).toEqual({
      ...(typeof original === 'object'
        ? original
        : {}),
      metadata: {
        'site-to-api-version': '1.2.3-beta.0',
        'site-to-api-sha256': expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
    expect(stamped.slice(stamped.indexOf('\n---\n', 3))).toBe(source.slice(source.indexOf('\n---\n', 3)))
    expect(readSkillCopy(stamped)).toEqual({ stamped: true, version: '1.2.3-beta.0', edited: false })
  })
})

describe('isOlderVersion', () => {
  it('compares major, minor and patch as numbers', () => {
    expect(isOlderVersion('0.1.2', '0.2.0')).toBe(true)
    expect(isOlderVersion('0.9.0', '0.10.0')).toBe(true)
    expect(isOlderVersion('1.0.0', '0.10.0')).toBe(false)
    expect(isOlderVersion('0.2.0', '0.2.0')).toBe(false)
  })

  it('puts a prerelease before its release', () => {
    expect(isOlderVersion('0.2.0-alpha.0', '0.2.0')).toBe(true)
    expect(isOlderVersion('0.2.0', '0.2.0-alpha.0')).toBe(false)
    expect(isOlderVersion('0.2.0-alpha.0', '0.2.0-alpha.1')).toBe(true)
    expect(isOlderVersion('0.2.0-beta.0', '0.2.0-alpha.1')).toBe(false)
  })

  it('never calls a version it cannot read older', () => {
    expect(isOlderVersion('dev', '0.2.0')).toBe(false)
    expect(isOlderVersion('0.1.0', 'dev')).toBe(false)
  })
})

describe('staleSkillNotice', () => {
  async function copy(relative: string, content: string): Promise<void> {
    await mkdir(dirname(join(dir, relative)), { recursive: true })
    await writeFile(join(dir, relative), content)
  }

  it('names the copies from an older version, edited or not, and says to run init --agent', async () => {
    await copy('.claude/skills/site-to-api/SKILL.md', stampSkill(SKILL, '0.1.2'))
    await copy('.agents/skills/site-to-api/SKILL.md', `${stampSkill(SKILL, '0.1.2')}\nOur own rule.\n`)
    expect(staleSkillNotice(dir, '0.2.0', dir)).toBe('Agents: this project\'s copy of the site-to-api skill (.claude/skills/site-to-api/SKILL.md, .agents/skills/site-to-api/SKILL.md) is from site-to-api 0.1.2; this is 0.2.0. Run `site-to-api init --agent` to update it.')
  })

  it('says nothing for current copies, unstamped copies or none', async () => {
    expect(staleSkillNotice(dir, '0.2.0', dir)).toBeNull()
    await copy('.claude/skills/site-to-api/SKILL.md', stampSkill(SKILL, '0.2.0'))
    await copy('.agents/skills/site-to-api/SKILL.md', SKILL)
    expect(staleSkillNotice(dir, '0.2.0', dir)).toBeNull()
  })
})
