import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './program'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-cli-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  await rm(dir, { recursive: true, force: true })
})

function captureStdout(): () => string {
  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  })
  return () => chunks.join('')
}

describe('cli', () => {
  it('init writes a config and gitignores raw captures, and is idempotent', async () => {
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      'init',
    ])
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      'init',
    ])
    const written = await readFile(join(dir, 'site-to-api.config.ts'), 'utf8')
    expect(written).toContain('defineConfig')
    // Redaction is a default, not a guarantee: the comment must not promise the folder is safe to publish.
    expect(written).toContain('Redacted by default; review it before publishing.')
    expect(written).not.toContain('safe to commit')
    expect(written).toContain('minimizePerHost: 5')
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8')
    expect(gitignore.match(/\.site-to-api\//g)).toHaveLength(1)
  })

  it('config --json shows values and their sources, with flags winning', async () => {
    const stdout = captureStdout()
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      '--out-dir',
      'custom',
      'config',
      '--json',
    ])
    const printed = JSON.parse(stdout()) as { config: { outDir: string }, sources: Record<string, string> }
    expect(printed.config.outDir).toBe('custom')
    expect(printed.sources.outDir).toBe('flag')
    expect(printed.sources.rawDir).toBe('default')
  })

  it('reports invalid configuration as a user error, not a crash', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.env.SITE_TO_API_PROBE__MAX_RPS = '999'
    try {
      await run([
        'node',
        'site-to-api',
        '--cwd',
        dir,
        'config',
      ])
    }
    finally {
      delete process.env.SITE_TO_API_PROBE__MAX_RPS
    }
    expect(process.exitCode).toBe(1)
  })
})
