import type { SkillCopy } from './skill'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'pathe'
import { VERSION } from '../version'
import { readSkillCopy, SKILL_COPIES, skillPathFor, stampSkill } from './skill'

const CONFIG_TEMPLATE = `import { defineConfig } from 'site-to-api'

export default defineConfig({
  // Raw captures hold real cookies, tokens and personal data. Keep this folder out of git.
  rawDir: '.site-to-api/raw',
  // The handoff folder for your coding agent. Redacted by default; review it before publishing.
  outDir: 'api-handoff',
  hosts: {
    // Leave empty to analyse every host the site's pages talk to (minus analytics and ads).
    include: [],
    exclude: [],
  },
  capture: {
    // Chrome by default, or Playwright's Chromium where Chrome is not installed. Set channel
    // ('chrome', 'msedge', ...) to require one browser, or null for Playwright's Chromium.
    browser: { headless: false },
  },
  redact: {
    // 'masked' keeps formats but hides secrets and personal data. 'raw' copies real values.
    examples: 'masked',
  },
  probe: {
    // Be polite to the site: requests per second when replaying.
    maxRps: 1,
    // Operations per host whose required cookies and headers are worked out one by one.
    minimizePerHost: 5,
  },
})
`

const GITIGNORE_ENTRY = `
# site-to-api raw captures: real cookies, tokens and personal data
.site-to-api/
`

const [CLAUDE_SKILL, AGENTS_SKILL] = SKILL_COPIES

/** In an instructions file, this text means a pointer to the skill is there already. */
const POINTER_MARK = 'skills/site-to-api/SKILL.md'

/** The instructions files `init --agent` adds a pointer to, with the skill copy each one names. */
const INSTRUCTIONS = [
  { file: 'AGENTS.md', skill: AGENTS_SKILL },
  { file: 'CLAUDE.md', skill: CLAUDE_SKILL },
]

export interface InitOptions {
  /**
   * The skill file to set the project up with for coding agents (`init --agent`): copied into
   * the project's skill folders, with a pointer line in its AGENTS.md and CLAUDE.md. Omit it
   * to leave agent files alone.
   */
  agentSkill?: string
  /** The package version the copies are stamped with; this package's own by default. */
  version?: string
}

export interface InitResult {
  created: string[]
  skipped: string[]
  /** Skill copies from an older version, unedited, replaced with this version's. */
  updated: string[]
  /** Files left alone for a reason the person should know, with what to do about it. */
  notes: string[]
}

/** Why an existing skill copy that differs from this version's was kept, and how to update it. */
function keptNote(path: string, copy: SkillCopy, skillPath: string, version: string): string {
  if (!copy.stamped)
    return `Kept ${path}: it differs from this version's skill and was not copied by \`init --agent\` (no site-to-api version in its frontmatter), so it may hold your own changes. Delete it and run \`site-to-api init --agent\` again to replace it.`
  return copy.version === version
    ? `Kept ${path}: it was edited after \`init --agent\` copied it.`
    : `Kept ${path}: it was edited after \`init --agent\` copied it from site-to-api ${copy.version}. To update it to ${version}, bring your changes over to ${skillPath}, or delete the copy and run \`site-to-api init --agent\` again.`
}

/**
 * Copies the skill, stamped with `version`, to each skill folder. An existing copy is replaced
 * only when its stamp shows `init --agent` wrote it and nobody edited it since: an older version
 * left as shipped. An edited copy, or one without a stamp (copied by hand or by `npx skills
 * add`) that differs from this version's skill, is kept, with how to update it.
 */
async function copySkill(cwd: string, skillPath: string, skill: string, version: string, result: InitResult): Promise<void> {
  const stamped = stampSkill(skill, version)
  for (const relative of SKILL_COPIES) {
    const path = join(cwd, relative)
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, stamped)
      result.created.push(path)
      continue
    }
    const current = await readFile(path, 'utf8')
    if (current === stamped || current === skill) {
      result.skipped.push(path)
      continue
    }
    const copy = readSkillCopy(current)
    if (copy.stamped && !copy.edited) {
      await writeFile(path, stamped)
      result.updated.push(path)
      result.notes.push(copy.version === version
        ? `Updated ${path}: it was this version's skill from another build, unedited.`
        : `Updated ${path} from site-to-api ${copy.version}'s skill to ${version}'s: it was unedited.`)
    }
    else {
      result.notes.push(keptNote(path, copy, skillPathFor(skillPath, cwd), version))
    }
  }
}

/** The line `init --agent` adds to an instructions file. */
function pointerLine(skill: string): string {
  return `site-to-api: before running \`site-to-api\` or working with its handoff folder (\`api-handoff/\`), read \`${skill}\`.`
}

/**
 * Adds a pointer to the skill to the project's AGENTS.md and CLAUDE.md, the ones that exist: an
 * agent reading them then learns the CLI's rules even where it does not load skills. A CLAUDE.md
 * that imports AGENTS.md gets the line through it. Neither file is created: what a project tells
 * its agents is the person's call, and the skill folders work without them.
 */
async function addPointers(cwd: string, result: InitResult): Promise<void> {
  const present = INSTRUCTIONS.filter(({ file }) => existsSync(join(cwd, file)))
  if (present.length === 0) {
    result.notes.push(`No AGENTS.md or CLAUDE.md here, so none was changed. Agents that load skills find the copies above; for others, add this line to the file your agent reads: ${pointerLine(AGENTS_SKILL)}`)
    return
  }
  for (const { file, skill } of present) {
    const path = join(cwd, file)
    const current = await readFile(path, 'utf8')
    if (current.includes(POINTER_MARK) || (file === 'CLAUDE.md' && current.includes('@AGENTS.md') && existsSync(join(cwd, 'AGENTS.md')))) {
      result.skipped.push(path)
      continue
    }
    const separator = current === '' || current.endsWith('\n\n')
      ? ''
      : current.endsWith('\n')
        ? '\n'
        : '\n\n'
    await appendFile(path, `${separator}${pointerLine(skill)}\n`)
    result.created.push(path)
  }
}

/**
 * Writes a starter config and makes sure raw captures are gitignored; with `agentSkill`, also
 * sets the project up for coding agents. Never overwrites a file the person may have changed:
 * the one file it replaces is a skill copy it wrote itself, unedited, from an older version.
 * Running it twice in a row changes nothing the second time.
 */
export async function initProject(cwd: string, options: InitOptions = {}): Promise<InitResult> {
  const result: InitResult = {
    created: [],
    skipped: [],
    updated: [],
    notes: [],
  }
  const { created, skipped } = result

  const configPath = join(cwd, 'site-to-api.config.ts')
  if (existsSync(configPath)) {
    skipped.push(configPath)
  }
  else {
    await writeFile(configPath, CONFIG_TEMPLATE)
    created.push(configPath)
  }

  const gitignorePath = join(cwd, '.gitignore')
  const current = existsSync(gitignorePath)
    ? await readFile(gitignorePath, 'utf8')
    : ''
  if (current.split('\n').some(line => line.trim() === '.site-to-api/')) {
    skipped.push(gitignorePath)
  }
  else {
    await appendFile(gitignorePath, GITIGNORE_ENTRY)
    created.push(gitignorePath)
  }

  if (options.agentSkill !== undefined) {
    await copySkill(cwd, options.agentSkill, await readFile(options.agentSkill, 'utf8'), options.version ?? VERSION, result)
    await addPointers(cwd, result)
  }

  return result
}
