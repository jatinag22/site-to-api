import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { consola } from 'consola'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpCommand } from './mcp'
import { run } from './program'

// The packaged skill exists only after a build; these tests use their own.
const packaged = vi.hoisted(() => {
  const state: { skill: string | null } = { skill: null }
  return state
})
vi.mock('./skill', async importOriginal => ({
  ...await importOriginal<typeof import('./skill')>(),
  packagedSkill: () => packaged.skill,
  skillPointer: () => packaged.skill === null
    ? null
    : `Agents: read ${packaged.skill}`,
}))

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-cli-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  packaged.skill = null
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

  it('init --agent copies the packaged skill into the project', async () => {
    packaged.skill = join(dir, 'SKILL.md')
    await writeFile(packaged.skill, '# site-to-api\n')
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      'init',
      '--agent',
    ])
    expect(await readFile(join(dir, '.claude', 'skills', 'site-to-api', 'SKILL.md'), 'utf8')).toBe('# site-to-api\n')
    expect(await readFile(join(dir, '.agents', 'skills', 'site-to-api', 'SKILL.md'), 'utf8')).toBe('# site-to-api\n')
  })

  it('init --agent fails, writing nothing, where the installation has no skill', async () => {
    const errors: string[] = []
    vi.spyOn(consola, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message))
    })
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      'init',
      '--agent',
    ])
    expect(process.exitCode).toBe(1)
    expect(errors[0]).toContain('has no agent skill')
    expect(existsSync(join(dir, 'site-to-api.config.ts'))).toBe(false)
  })

  it('--help ends with where the agent skill is', async () => {
    packaged.skill = join(dir, 'SKILL.md')
    const stdout = captureStdout()
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit ${code}`)
    })
    await expect(run(['node', 'site-to-api', '--help'])).rejects.toThrow('exit 0')
    expect(stdout().trimEnd().split('\n').at(-1)).toBe(`Agents: read ${packaged.skill}`)
  })

  it('refuses a --cwd that does not exist instead of running with defaults', async () => {
    const errors: string[] = []
    vi.spyOn(consola, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message))
    })
    await run([
      'node',
      'site-to-api',
      '--cwd',
      join(dir, 'missing'),
      'config',
    ])
    expect(errors).toEqual([
      expect.stringMatching(/^--cwd .*missing: no such directory/),
    ])
    expect(process.exitCode).toBe(1)
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
    await writeFile(join(dir, 'site-to-api.config.ts'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default { outDir: process.env.HANDOFF ?? 'handoff' }\n`)
    // A plain literal outDir is read as text (decision 0058); a computed one cannot be, so it is reported.
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
    expect(stderr.join('')).toContain(`Not running ${join(dir, 'site-to-api.config.ts')}: \`mcp\` reads only flags, SITE_TO_API_* variables and site-to-api.config.json, so its outDir is not used`)
    expect(process.exitCode).toBe(1)
  })

  it('says nothing about a code config that changes nothing mcp uses', async () => {
    await writeFile(join(dir, 'site-to-api.config.ts'), `export default { outDir: 'api-handoff', probe: { maxRps: 1 } }\n`)
    const stderr: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
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
    expect(stderr.join('')).not.toContain('Not running')
  })

  it('reads a plain outDir from a .ts config file without running it (decision 0058)', async () => {
    const marker = join(dir, 'ran.txt')
    await writeFile(join(dir, 'site-to-api.config.ts'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n// outDir: 'commented'\nexport default { outDir: 'src/api/shop' }\n`)
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
