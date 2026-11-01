import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpCommand } from './mcp'
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

describe('mcp', () => {
  it('never runs a .ts config file, which a project can fill with any code', async () => {
    const marker = join(dir, 'ran.txt')
    await writeFile(join(dir, 'site-to-api.config.ts'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default {}\n`)
    const stderr: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    })
    // --generated with no generated server ends right after the config is read, before serving.
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      'mcp',
      '--generated',
    ], [mcpCommand])
    expect(existsSync(marker)).toBe(false)
    expect(stderr.join('')).toContain(`Not running ${join(dir, 'site-to-api.config.ts')}`)
    expect(process.exitCode).toBe(1)
  })

  it('reads a plain outDir from a .ts config file without running it (decision 0057)', async () => {
    const marker = join(dir, 'ran.txt')
    await writeFile(join(dir, 'site-to-api.config.ts'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default { outDir: 'src/api/shop' }\n`)
    const output: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk))
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk))
      return true
    })
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      'mcp',
      '--generated',
    ], [mcpCommand])
    expect(existsSync(marker)).toBe(false)
    expect(output.join('')).toContain(`No generated MCP server at ${join(dir, 'src', 'api', 'shop', 'mcp', 'server.ts')}`)
    expect(output.join('')).not.toContain('Not running')
  })
})
