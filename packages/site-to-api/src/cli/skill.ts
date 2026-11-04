/**
 * The agent skill that ships in the package (`skills/site-to-api/SKILL.md`, copied there by the
 * build from the repository's `skills/`). The CLI points agents at it and `init --agent` copies it
 * into a project, stamped with the version it came from so a later version can tell an unedited
 * old copy from an edited one.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import { SiteToApiError } from '../errors'
import { VERSION } from '../version'
import { shown } from './output'

const SKILL_PATH = [
  'skills',
  'site-to-api',
  'SKILL.md',
]

/**
 * Where `init --agent` puts the skill, relative to the project: Claude Code's project skills, and
 * the shared folder that Codex and other agents reading Agent Skills use (the one `npx skills add`
 * writes for them).
 */
export const SKILL_COPIES = [
  '.claude/skills/site-to-api/SKILL.md',
  '.agents/skills/site-to-api/SKILL.md',
] as const

/**
 * Where this installation's skill is, or `null` when it has none (a source checkout that was
 * not built). Resolved from the running package, so it is right for global and nested installs.
 */
export function packagedSkill(): string | null {
  const root = dirname(fileURLToPath(import.meta.resolve('site-to-api/package.json')))
  const path = join(root, ...SKILL_PATH)
  return existsSync(path)
    ? path
    : null
}

/**
 * The skill's path as the person would type it. Node resolves the package through its real path,
 * which under pnpm is deep in `node_modules/.pnpm/`; when the project's own
 * `node_modules/site-to-api` is the same package, that shorter path is shown.
 */
export function skillPathFor(skill: string, project: string, cwd: string = process.cwd()): string {
  const linked = join(project, 'node_modules', 'site-to-api', ...SKILL_PATH)
  if (existsSync(linked) && realpathSync(linked) === realpathSync(skill))
    return shown(linked, cwd)
  return shown(skill, cwd)
}

/** One line for agents: where the skill is. `null` when this installation has none. */
export function skillPointer(project: string): string | null {
  const skill = packagedSkill()
  return skill === null
    ? null
    : `Agents: read ${skillPathFor(skill, project)} for the CLI's rules and workflow (\`site-to-api init --agent\` adds it to the project).`
}

/**
 * The stamp `init --agent` writes as the copy's last frontmatter field, under `metadata` (the
 * Agent Skills field for extra string keys, which loaders ignore or pass through): the package
 * version the copy came from and a SHA-256 of the skill as that version shipped it. The hash
 * tells an unedited copy, safe to replace, from one the person changed, without keeping every
 * old version's skill around.
 */
const STAMP = /^metadata:\n {2}site-to-api-version: "([^"\n]+)"\n {2}site-to-api-sha256: "([0-9a-f]{64})"\n/m

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Offset of the frontmatter's closing `---` line, where the stamp goes; `-1` without frontmatter. */
function frontmatterEnd(skill: string): number {
  if (!skill.startsWith('---\n'))
    return -1
  const end = skill.indexOf('\n---\n', 3)
  return end === -1
    ? -1
    : end + 1
}

/**
 * The skill with its version stamp added as the frontmatter's last field. Throws when the skill
 * has no frontmatter or a `metadata` field of its own (a second one would be invalid YAML): the
 * build ships the repository's skill, which has neither, so this means a broken installation.
 */
export function stampSkill(skill: string, version: string): string {
  const end = frontmatterEnd(skill)
  if (end === -1 || /^metadata:/m.test(skill.slice(0, end)))
    throw new SiteToApiError('This copy of site-to-api has an agent skill without frontmatter, or with a `metadata` field of its own, so `init --agent` cannot record its version in the copy. Reinstall site-to-api from npm.')
  return `${skill.slice(0, end)}metadata:\n  site-to-api-version: "${version}"\n  site-to-api-sha256: "${sha256(skill)}"\n${skill.slice(end)}`
}

/** What a project's copy of the skill says about where it came from. */
export type SkillCopy
  /** No stamp: copied by hand, by `npx skills add`, or with the stamp lines changed. */
  = | { stamped: false }
  /** Copied by `init --agent` from `version`; `edited` when it no longer matches that version's skill. */
    | { stamped: true, version: string, edited: boolean }

/** Reads the stamp `stampSkill` wrote, and checks the rest of the file against its hash. */
export function readSkillCopy(copy: string): SkillCopy {
  const end = frontmatterEnd(copy)
  const match = end === -1
    ? null
    : STAMP.exec(copy.slice(0, end))
  if (match === null)
    return { stamped: false }
  const [lines, version = '', hash = ''] = match
  const original = copy.slice(0, match.index) + copy.slice(match.index + lines.length)
  return { stamped: true, version, edited: sha256(original) !== hash }
}

/** `major.minor.patch` with an optional `-prerelease`; `null` for anything else. */
function parseVersion(version: string): { numbers: number[], pre: string } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(version)
  if (match === null)
    return null
  return {
    numbers: [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ],
    pre: match[4] ?? '',
  }
}

/**
 * Whether version `a` comes before `b`. A prerelease comes before its release; prereleases of one
 * version compare as text, which orders `alpha.0` < `alpha.1` < `beta.0`. A version that does not
 * parse is never older, so an odd stamp produces no hint rather than a wrong one.
 */
export function isOlderVersion(a: string, b: string): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null)
    return false
  for (let i = 0; i < 3; i++) {
    const difference = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0)
    if (difference !== 0)
      return difference < 0
  }
  if (left.pre === right.pre)
    return false
  if (left.pre === '')
    return false
  if (right.pre === '')
    return true
  return left.pre < right.pre
}

/**
 * One line when the project's skill copies came from an older site-to-api than `version`, saying
 * how to update them; `null` when they are current, not made by `init --agent`, or absent. Edited
 * copies count too: `init --agent` then keeps them and says how to bring them up to date.
 */
export function staleSkillNotice(project: string, version: string = VERSION, cwd: string = process.cwd()): string | null {
  const stale: { path: string, version: string }[] = []
  for (const relative of SKILL_COPIES) {
    const path = join(project, relative)
    if (!existsSync(path))
      continue
    const copy = readSkillCopy(readFileSync(path, 'utf8'))
    if (copy.stamped && isOlderVersion(copy.version, version)) {
      stale.push({
        path: shown(path, cwd),
        version: copy.version,
      })
    }
  }
  if (stale.length === 0)
    return null
  const from = [
    ...new Set(stale.map(copy => copy.version)),
  ].sort().join(' and ')
  return `Agents: this project's copy of the site-to-api skill (${stale.map(copy => copy.path).join(', ')}) is from site-to-api ${from}; this is ${version}. Run \`site-to-api init --agent\` to update it.`
}
