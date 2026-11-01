#!/usr/bin/env node
// Packs both packages and uses them the way a user would, outside the workspace (RELEASING.md):
// the packed manifests hold no `workspace:`/`catalog:` ranges and pass publint, the runtime
// bundles for a neutral (non-Node) platform, and the tarballs install with npm and with pnpm
// into fresh projects where `--help`, `init`, `capture` (headless, Playwright's Chromium) against
// the e2e fixture site, `build` and `gen` work and the generated client type-checks.
//
// Usage: node scripts/smoke-package.mjs [--static] [--tarballs <dir>] [--keep] [--only npm|pnpm] [--with-deps]
//   --static     only the quick checks: pack, manifests, publint, and the runtime's neutrality
//                (the runtime tarball alone is installed for it); no browser, no capture
//   --tarballs   test these tarballs instead of packing (the release tests the exact files it
//                publishes); a SHA256SUMS file next to them is checked first
//   --keep       leave the temporary folder for inspection
//   --only       test one package manager only
//   --with-deps  install Chromium's system libraries too (CI runners)
// Needs network access for npm and pnpm installs. Run from the repository root after
// `pnpm install`.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { neutralProblems } from './check-neutral.mjs'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const staticOnly = args.includes('--static')
const withDeps = args.includes('--with-deps')
const only = args.includes('--only')
  ? args[args.indexOf('--only') + 1]
  : null
const given = args.includes('--tarballs')
  ? resolve(args[args.indexOf('--tarballs') + 1] ?? '')
  : null
const managers = only === null
  ? ['npm', 'pnpm']
  : [only]
// Versions for the fresh projects, from the workspace catalog, so the smoke test uses what
// the repository is tested with.
const catalog = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
function catalogVersion(name) {
  const match = new RegExp(`^\\s+'?${name.replace('/', '\\/')}'?: (\\S+)$`, 'm').exec(catalog)
  if (match === null)
    fail(`no catalog version for ${name} in pnpm-workspace.yaml`)
  return match[1]
}

function fail(message) {
  console.error(`\nsmoke-package: FAILED: ${message}`)
  process.exit(1)
}

function step(message) {
  console.log(`\n== ${message}`)
}

/** Runs a command and fails the smoke test when it exits non-zero. */
function run(command, commandArgs, options = {}) {
  console.log(`$ ${command} ${commandArgs.join(' ')}${options.cwd
    ? `   (in ${options.cwd})`
    : ''}`)
  const result = spawnSync(command, commandArgs, {
    stdio: options.capture
      ? ['ignore', 'pipe', 'inherit']
      : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
    env: {
      ...process.env,
      ...options.env,
    },
  })
  if (result.status !== 0)
    fail(`${command} ${commandArgs.join(' ')} exited with ${result.status ?? result.signal}`)
  return result.stdout ?? ''
}

const work = mkdtempSync(join(tmpdir(), 'site-to-api-smoke-'))
const tarballs = given ?? join(work, 'tarballs')
if (given === null)
  mkdirSync(tarballs)
let fixture = null
process.on('exit', () => {
  // The fixture runs under pnpm and tsx: stop the whole process group, not only pnpm.
  if (fixture?.pid !== undefined) {
    try {
      process.kill(-fixture.pid, 'SIGTERM')
    }
    catch {}
  }
  if (!keep)
    rmSync(work, { recursive: true, force: true })
  else
    console.log(`\nKept ${work}`)
})

if (given === null) {
  // 1. Pack. pnpm replaces `workspace:` and `catalog:` ranges with real versions while packing.
  step('Pack both packages')
  run('pnpm', [
    '--filter',
    'site-to-api',
    '--filter',
    '@site-to-api/runtime',
    'pack',
    '--pack-destination',
    tarballs,
  ], { cwd: root })
}
else {
  // 1. The given tarballs, checked against their SHA256SUMS when there is one.
  step(`Use the tarballs in ${given}`)
  const sums = readdirSync(given).includes('SHA256SUMS')
    ? readFileSync(join(given, 'SHA256SUMS'), 'utf8').trim().split('\n')
    : []
  for (const line of sums) {
    const [expected, file] = line.trim().split(/\s+\*?/)
    const actual = createHash('sha256').update(readFileSync(join(given, file ?? ''))).digest('hex')
    if (actual !== expected)
      fail(`${file}: sha256 ${actual} does not match SHA256SUMS (${expected})`)
    console.log(`${file}: sha256 matches`)
  }
}
const packed = readdirSync(tarballs).filter(file => file.endsWith('.tgz'))
const cliTarball = packed.find(file => file.startsWith('site-to-api-') && !file.startsWith('site-to-api-runtime-'))
const runtimeTarball = packed.find(file => file.startsWith('site-to-api-runtime-'))
if (packed.length !== 2 || cliTarball === undefined || runtimeTarball === undefined)
  fail(`expected two tarballs, got: ${packed.join(', ')}`)

// 2. Inspect each tarball: no workspace or catalog ranges, publint clean.
for (const tarball of [cliTarball, runtimeTarball]) {
  step(`Inspect ${tarball}`)
  const dir = join(work, 'extracted', tarball.replace(/\.tgz$/, ''))
  mkdirSync(dir, { recursive: true })
  run('tar', [
    '-xzf',
    join(tarballs, tarball),
    '-C',
    dir,
  ])
  const manifest = readFileSync(join(dir, 'package', 'package.json'), 'utf8')
  const leftover = /"(?:workspace|catalog):[^"]*"/.exec(manifest)
  if (leftover !== null)
    fail(`${tarball}: package.json still holds ${leftover[0]}`)
  run('pnpm', [
    'exec',
    'publint',
    join(dir, 'package'),
    '--strict',
  ], { cwd: root })
}

// 3. Fresh projects, one per package manager.
const version = /^site-to-api-runtime-(.+)\.tgz$/.exec(runtimeTarball)?.[1]
const projects = []
for (const manager of staticOnly
  ? []
  : managers) {
  step(`Install the tarballs with ${manager}`)
  const dir = join(work, `${manager}-app`)
  mkdirSync(dir)
  const cli = `file:${join(tarballs, cliTarball)}`
  const runtime = `file:${join(tarballs, runtimeTarball)}`
  const manifest = {
    name: `smoke-${manager}`,
    private: true,
    type: 'module',
    dependencies: {
      '@site-to-api/runtime': runtime,
      'site-to-api': cli,
      'typescript': catalogVersion('typescript'),
      'zod': catalogVersion('zod'),
    },
    // site-to-api depends on `@site-to-api/runtime@<version>`, which is not on the registry
    // for an alpha: pnpm needs an override to take the tarball; npm takes the top-level one.
    ...(manager === 'pnpm'
      ? {
          pnpm: {
            overrides: { '@site-to-api/runtime': runtime },
          },
        }
      : {}),
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (manager === 'npm')
    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir })
  else
    run('pnpm', ['install', '--ignore-workspace', '--config.confirmModulesPurge=false'], { cwd: dir })
  const installed = JSON.parse(readFileSync(join(dir, 'node_modules', '@site-to-api', 'runtime', 'package.json'), 'utf8')).version
  if (installed !== version)
    fail(`${manager}: installed @site-to-api/runtime ${installed}, expected ${version}`)
  projects.push({ manager, dir })
}

// 4. The runtime must run outside Node (Bun, Deno, edge workers): no Node imports or globals.
step('Bundle the runtime for a neutral platform')
let neutralDir = projects[0]?.dir
if (neutralDir === undefined) {
  // Static mode: a project with the runtime tarball alone, so its dependencies resolve.
  neutralDir = join(work, 'runtime-app')
  mkdirSync(neutralDir)
  writeFileSync(join(neutralDir, 'package.json'), `${JSON.stringify({
    name: 'smoke-runtime',
    private: true,
    type: 'module',
    dependencies: { '@site-to-api/runtime': `file:${join(tarballs, runtimeTarball)}` },
  }, null, 2)}\n`)
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: neutralDir })
}
const problems = await neutralProblems(join(neutralDir, 'node_modules', '@site-to-api', 'runtime', 'dist', 'index.mjs'))
if (problems.length > 0)
  fail(`the runtime is not neutral:\n  ${problems.join('\n  ')}`)
console.log('runtime bundles for platform=neutral with no Node imports or globals')
if (staticOnly) {
  console.log('\nsmoke-package: static checks OK')
  process.exit(0)
}

// 5. The fixture site, which the e2e tests capture too.
step('Start the e2e fixture site')
const origin = await new Promise((done) => {
  fixture = spawn('pnpm', [
    '--filter',
    '@site-to-api/e2e',
    'exec',
    'tsx',
    'fixture-site/serve.ts',
  ], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  })
  let output = ''
  const timer = setTimeout(fail, 60_000, 'the fixture site did not start within 60 s')
  fixture.stdout.on('data', (chunk) => {
    output += chunk
    const match = /Pinewood Market: (http:\/\/\S+)/.exec(output)
    if (match !== null) {
      clearTimeout(timer)
      done(match[1])
    }
  })
  fixture.on('exit', code => fail(`the fixture site stopped (exit ${code})`))
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => process.exit(1))
})
console.log(`fixture site at ${origin}`)

const captureScript = `// Smoke capture: home page, a category, a product.
export default async ({ page, baseUrl }) => {
  await page.goto(baseUrl)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Snacks', exact: true }).click()
  const grid = page.locator('#product-grid')
  await grid.getByRole('link').first().waitFor()
  await grid.getByRole('link').first().click()
  await page.locator('#product-name').filter({ hasNotText: 'Loading' }).waitFor()
  await page.waitForLoadState('networkidle')
}
`

for (const { manager, dir } of projects) {
  const exec = manager === 'npm'
    ? [
        'npx',
        ['--no-install', 'site-to-api'],
      ]
    : [
        'pnpm',
        ['exec', 'site-to-api'],
      ]
  const cli = (cliArgs, options) => run(exec[0], [
    ...exec[1],
    ...cliArgs,
  ], { cwd: dir, ...options })

  step(`${manager}: --help and init`)
  const help = cli(['--help'], { capture: true })
  if (!help.includes('capture') || !help.includes('build'))
    fail(`${manager}: --help does not list the commands`)
  cli(['init'])
  if (!readFileSync(join(dir, 'site-to-api.config.ts'), 'utf8').includes('defineConfig'))
    fail(`${manager}: init wrote no config`)

  step(`${manager}: Playwright's Chromium`)
  // The Playwright that site-to-api depends on (pnpm does not expose it at the project's root).
  const playwright = createRequire(realpathSync(join(dir, 'node_modules', 'site-to-api', 'package.json'))).resolve('playwright/package.json')
  run(process.execPath, [
    join(dirname(playwright), 'cli.js'),
    'install',
    ...(withDeps
      ? ['--with-deps']
      : []),
    'chromium',
  ], { cwd: dir })

  step(`${manager}: capture, build, gen against the fixture site`)
  // A config for an unattended run: headless bundled Chromium. Linux CI runners cannot start
  // Chromium's sandbox, so it is off there (as in the e2e tests).
  writeFileSync(join(dir, 'site-to-api.config.ts'), `import { defineConfig } from 'site-to-api'

export default defineConfig({
  capture: { browser: { channel: null, headless: true, sandbox: ${process.env.CI === 'true'
    ? 'false'
    : 'true'} } },
})
`)
  writeFileSync(join(dir, 'capture.mjs'), captureScript)
  cli([
    'capture',
    origin,
    '--script',
    './capture.mjs',
    '--session',
    'smoke',
  ])
  cli(['build'])
  cli(['gen'])

  step(`${manager}: type-check the generated client`)
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      // The strictest flags an app may turn on (decision 0058).
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2023',
      noEmit: true,
      skipLibCheck: false,
      types: [],
    },
    // The MCP server sits next to the client (api-handoff/mcp), outside this include.
    include: ['api-handoff/client/**/*.ts'],
  }, null, 2)}\n`)
  run(exec[0], [
    ...(manager === 'npm'
      ? ['--no-install']
      : ['exec']),
    'tsc',
    '-p',
    'tsconfig.json',
  ], { cwd: dir })
  console.log(`${manager}: generated client type-checks`)
}

console.log('\nsmoke-package: OK')
// The fixture site's output pipe keeps the event loop alive; the exit handler stops it.
process.exit(0)
