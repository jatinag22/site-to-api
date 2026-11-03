import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initProject } from './init'

const SKILL = '---\nname: site-to-api\n---\n\n# site-to-api\n'

let dir: string
let skill: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-init-'))
  skill = join(dir, 'packaged-SKILL.md')
  await writeFile(skill, SKILL)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const claudeSkill = (): string => join(dir, '.claude', 'skills', 'site-to-api', 'SKILL.md')
const agentsSkill = (): string => join(dir, '.agents', 'skills', 'site-to-api', 'SKILL.md')

describe('initProject with agentSkill', () => {
  it('leaves agent files alone without it', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '# Rules\n')
    await initProject(dir)
    expect(existsSync(claudeSkill())).toBe(false)
    expect(existsSync(agentsSkill())).toBe(false)
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('# Rules\n')
  })

  it('copies the skill for Claude Code and other agents and points AGENTS.md at it', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '# Rules\n\n- Be kind.\n')
    const result = await initProject(dir, { agentSkill: skill })
    expect(await readFile(claudeSkill(), 'utf8')).toBe(SKILL)
    expect(await readFile(agentsSkill(), 'utf8')).toBe(SKILL)
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('# Rules\n\n- Be kind.\n\nsite-to-api: before running `site-to-api` or working with its handoff folder (`api-handoff/`), read `.agents/skills/site-to-api/SKILL.md`.\n')
    expect(result.created).toEqual(expect.arrayContaining([
      claudeSkill(),
      agentsSkill(),
      join(dir, 'AGENTS.md'),
    ]))
    expect(result.notes).toEqual([])
  })

  it('changes nothing when run again', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '# Rules')
    await writeFile(join(dir, 'CLAUDE.md'), '# Claude\n')
    await initProject(dir, { agentSkill: skill })
    const files = [
      join(dir, 'AGENTS.md'),
      join(dir, 'CLAUDE.md'),
      join(dir, '.gitignore'),
      join(dir, 'site-to-api.config.ts'),
      claudeSkill(),
      agentsSkill(),
    ]
    const first = await Promise.all(files.map(async file => readFile(file, 'utf8')))
    // A file without a final newline gets a blank line before the pointer.
    expect(first[0]).toMatch(/^# Rules\n\nsite-to-api: .*`\.agents\/skills\/site-to-api\/SKILL\.md`\.\n$/)
    expect(first[1]).toMatch(/^# Claude\n\nsite-to-api: .*`\.claude\/skills\/site-to-api\/SKILL\.md`\.\n$/)
    const again = await initProject(dir, { agentSkill: skill })
    expect(again.created).toEqual([])
    expect(again.notes).toEqual([])
    expect(await Promise.all(files.map(async file => readFile(file, 'utf8')))).toEqual(first)
  })

  it('keeps a skill copy the person edited and says how to replace it', async () => {
    await mkdir(join(dir, '.claude', 'skills', 'site-to-api'), { recursive: true })
    await writeFile(claudeSkill(), `${SKILL}\nOur own rule.\n`)
    const result = await initProject(dir, { agentSkill: skill })
    expect(await readFile(claudeSkill(), 'utf8')).toBe(`${SKILL}\nOur own rule.\n`)
    expect(await readFile(agentsSkill(), 'utf8')).toBe(SKILL)
    expect(result.created).not.toContain(claudeSkill())
    expect(result.notes).toContainEqual(expect.stringContaining(`Kept ${claudeSkill()}: it differs from this version's skill`))
  })

  it('keeps a pointer the person already wrote, in their own words', async () => {
    const own = '# Rules\n\nSee .agents/skills/site-to-api/SKILL.md for scraping.\n'
    await writeFile(join(dir, 'AGENTS.md'), own)
    await initProject(dir, { agentSkill: skill })
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(own)
  })

  it('leaves a CLAUDE.md that imports AGENTS.md alone: it gets the line through AGENTS.md', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '# Rules\n')
    await writeFile(join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
    await initProject(dir, { agentSkill: skill })
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('.agents/skills/site-to-api/SKILL.md')
  })

  it('creates no AGENTS.md or CLAUDE.md and says what line to add', async () => {
    const result = await initProject(dir, { agentSkill: skill })
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
    expect(result.notes).toEqual([
      expect.stringMatching(/^No AGENTS\.md or CLAUDE\.md here, so none was changed\..*site-to-api: before running/),
    ])
  })
})
