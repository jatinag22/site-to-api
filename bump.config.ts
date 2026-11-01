/**
 * `pnpm run release` (bumpp): bumps every package to one version (decision 0007) on a
 * `release/v<version>` branch and opens a pull request; `main` is protected, so nothing is pushed
 * to it. Merging the pull request runs `.github/workflows/release.yml`, which checks the version,
 * runs CI and the package smoke test on the merge commit, tags it and creates the GitHub release.
 * See RELEASING.md.
 */
import { execFileSync } from 'node:child_process'
import { defineConfig } from 'bumpp'

/** The `Signed-off-by` trailer (DCO) for whoever runs the release, from their git config. */
function signOff(): string {
  const read = (key: string): string => {
    try {
      return execFileSync('git', ['config', key], { encoding: 'utf8' }).trim()
    }
    catch {
      return ''
    }
  }
  const name = read('user.name')
  const email = read('user.email')
  if (name === '' || email === '')
    throw new Error('Set git user.name and user.email before releasing: the release commit is signed off (DCO).')
  return `Signed-off-by: ${name} <${email}>`
}

export default defineConfig({
  recursive: true,
  // The commit-msg hook wants a Conventional Commit with a body; the DCO wants a sign-off.
  commit: [
    'chore: release v{version}',
    '',
    'Bumps every package from {oldVersion} to {version} so they release together',
    '(decision 0007). Merging this pull request tags the merge commit and creates the',
    'GitHub release (RELEASING.md).',
    '',
    signOff(),
  ].join('\n'),
  pr: {
    branch: 'release/v{version}',
    base: 'main',
    title: 'chore: release v{version}',
  },
  push: true,
  // The tag is created by the release workflow after the pull request is merged.
  tag: false,
})
