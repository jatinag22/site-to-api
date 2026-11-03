/**
 * The agent skill that ships in the package (`skills/site-to-api/SKILL.md`, copied there by the
 * build from the repository's `skills/`). The CLI points agents at it and `init --agent` copies it
 * into a project.
 */
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import { shown } from './output'

const SKILL_PATH = [
  'skills',
  'site-to-api',
  'SKILL.md',
]

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
