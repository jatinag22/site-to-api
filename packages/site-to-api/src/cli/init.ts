import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'pathe'

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

/**
 * Where `init --agent` puts the skill: Claude Code's project skills, and the shared folder that
 * Codex and other agents reading Agent Skills use (the one `npx skills add` writes for them).
 */
const CLAUDE_SKILL = '.claude/skills/site-to-api/SKILL.md'
const AGENTS_SKILL = '.agents/skills/site-to-api/SKILL.md'

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
}

export interface InitResult {
  created: string[]
  skipped: string[]
  /** Files left alone for a reason the person should know, with what to do about it. */
  notes: string[]
}

async function copySkill(cwd: string, skill: string, result: InitResult): Promise<void> {
  for (const relative of [CLAUDE_SKILL, AGENTS_SKILL]) {
    const path = join(cwd, relative)
    if (!existsSync(path)) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, skill)
      result.created.push(path)
    }
    else if (await readFile(path, 'utf8') === skill) {
      result.skipped.push(path)
    }
    else {
      // Edited by hand, or from another version: never overwritten.
      result.notes.push(`Kept ${path}: it differs from this version's skill (edited, or from another version). Delete it and run \`site-to-api init --agent\` again to replace it.`)
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
 * sets the project up for coding agents. Never overwrites a file: running it again changes
 * nothing.
 */
export async function initProject(cwd: string, options: InitOptions = {}): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], notes: [] }
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
    await copySkill(cwd, await readFile(options.agentSkill, 'utf8'), result)
    await addPointers(cwd, result)
  }

  return result
}
