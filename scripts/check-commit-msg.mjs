// Enforces Conventional Commits with a body that explains why (docs/decisions/0005-git-workflow.md).
import { readFileSync } from 'node:fs'
import process from 'node:process'

const file = process.argv[2]
if (!file) {
  console.error('check-commit-msg: missing commit message file argument')
  process.exit(1)
}

const lines = readFileSync(file, 'utf8')
  .split('\n')
  .filter(line => !line.startsWith('#'))

const subject = lines[0]?.trim() ?? ''
const types = [
  'feat',
  'fix',
  'docs',
  'chore',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'style',
  'revert',
]
const pattern = new RegExp(`^(?:${types.join('|')})(?:\\([a-z0-9-]+\\))?!?: .{3,}$`)

if (/^(?:Merge|Revert|fixup!|squash!)/.test(subject))
  process.exit(0)

if (!pattern.test(subject)) {
  console.error(`check-commit-msg: subject must follow Conventional Commits, e.g. "feat(build): infer path parameters"\n  got: "${subject}"`)
  process.exit(1)
}

if (subject.length > 100) {
  console.error('check-commit-msg: keep the subject under 100 characters')
  process.exit(1)
}

const body = lines.slice(1).join('\n').trim()
if (body.length < 20) {
  console.error('check-commit-msg: add a body explaining why the change was made')
  process.exit(1)
}
