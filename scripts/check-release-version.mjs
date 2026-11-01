#!/usr/bin/env node
// Checks that every package has the same version (decision 0007) and, when a tag is given, that
// the tag names it (`v1.2.3` for version 1.2.3). Prints the version; in GitHub Actions also writes
// `version=` and `tag=` to $GITHUB_OUTPUT. Used by .github/workflows/release.yml.
//
// Usage: node scripts/check-release-version.mjs [tag]
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const tag = process.argv[2] ?? ''

const manifests = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(root, 'packages', entry.name, 'package.json'))
const versions = manifests.map((file) => {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  return { name: manifest.name, version: manifest.version }
})
const distinct = [
  ...new Set(versions.map(item => item.version)),
]
if (distinct.length !== 1) {
  console.error(`check-release-version: packages disagree on the version: ${versions.map(item => `${item.name}@${item.version}`).join(', ')}`)
  process.exit(1)
}
const version = distinct[0]
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(`check-release-version: "${version}" is not a release version`)
  process.exit(1)
}
if (version === '0.0.0') {
  console.error('check-release-version: the version is still 0.0.0; run `pnpm run release` first')
  process.exit(1)
}
if (tag !== '' && tag !== `v${version}`) {
  console.error(`check-release-version: tag ${tag} does not match the package version ${version} (expected v${version})`)
  process.exit(1)
}
console.log(`version ${version}: ${versions.map(item => item.name).join(', ')}`)
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\nprerelease=${version.includes('-')}\n`)
