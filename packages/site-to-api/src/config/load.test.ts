import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configFromEnv, loadConfig } from './load'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('configFromEnv', () => {
  it('maps prefixed variables to nested camelCase keys and parses JSON values', () => {
    expect(configFromEnv({
      SITE_TO_API_RAW_DIR: '/tmp/raw',
      SITE_TO_API_REDACT__EXAMPLES: 'raw',
      SITE_TO_API_PROBE__MAX_RPS: '0.5',
      SITE_TO_API_CAPTURE__BROWSER__HEADLESS: 'true',
      SITE_TO_API_HOSTS__INCLUDE: '["*.example.com"]',
      UNRELATED: 'x',
    })).toEqual({
      rawDir: '/tmp/raw',
      redact: { examples: 'raw' },
      probe: { maxRps: 0.5 },
      capture: {
        browser: { headless: true },
      },
      hosts: {
        include: ['*.example.com'],
      },
    })
  })
})

describe('loadConfig', () => {
  it('returns defaults when nothing is configured', async () => {
    const { config, file, sources } = await loadConfig({ cwd: dir })
    expect(file).toBeNull()
    expect(config.rawDir).toBe('.site-to-api/raw')
    expect(config.redact.examples).toBe('masked')
    expect(config.probe.unsafeMethods).toBe(false)
    expect(sources['redact.examples']).toBe('default')
  })

  it('applies file, then env, then flags, and records each source', async () => {
    await writeFile(join(dir, 'site-to-api.config.ts'), `
      export default { outDir: 'from-file', redact: { examples: 'none', maxExamples: 5 }, probe: { maxRps: 2 } }
    `)
    const { config, file, sources } = await loadConfig({
      cwd: dir,
      env: { SITE_TO_API_REDACT__EXAMPLES: 'raw', SITE_TO_API_PROBE__MAX_RPS: '3' },
      flags: {
        probe: { maxRps: 0.25 },
      },
    })
    expect(file).toBe(join(dir, 'site-to-api.config.ts'))
    expect(config.outDir).toBe('from-file')
    expect(config.redact.examples).toBe('raw')
    expect(config.redact.maxExamples).toBe(5)
    expect(config.probe.maxRps).toBe(0.25)
    expect(sources).toMatchObject({
      'outDir': 'file',
      'redact.examples': 'env',
      'redact.maxExamples': 'file',
      'probe.maxRps': 'flag',
      'rawDir': 'default',
    })
  })

  it('rejects unknown keys and invalid values with a readable message', async () => {
    await expect(loadConfig({
      cwd: dir,
      flags: {
        redact: { exampels: 'raw' },
      },
    })).rejects.toThrow(/Invalid configuration/)
    await expect(loadConfig({
      cwd: dir,
      env: { SITE_TO_API_PROBE__MAX_RPS: '50' },
    })).rejects.toThrow(/maxRps/)
  })

  it('names the source of each bad value and suggests the key that was meant', async () => {
    await writeFile(join(dir, 'site-to-api.config.json'), JSON.stringify({
      probe: { maxRp: 2 },
      captur: {},
    }))
    const error = await loadConfig({
      cwd: dir,
      env: { SITE_TO_API_PROBE__MINIMIZEPERHOST: '3', SITE_TO_API_PROBE__TIMEOUT_MS: 'soon' },
      flags: {
        redact: { examples: 'everything' },
      },
    }).catch((caught: unknown) => caught)
    const file = join(dir, 'site-to-api.config.json')
    expect(String(error)).toContain(`- captur (config file ${file}): unknown key. Did you mean "capture"?`)
    expect(String(error)).toContain(`- probe.maxRp (config file ${file}): unknown key. Did you mean "probe.maxRps"?`)
    expect(String(error)).toContain('- probe.minimizeperhost (environment variable SITE_TO_API_PROBE__MINIMIZEPERHOST): unknown key. Did you mean SITE_TO_API_PROBE__MINIMIZE_PER_HOST?')
    expect(String(error)).toContain('- probe.timeoutMs (environment variable SITE_TO_API_PROBE__TIMEOUT_MS): Invalid input: expected number, received string')
    expect(String(error)).toMatch(/- redact\.examples \(CLI flag --examples\): Invalid option/)
  })

  it('shows the line of a config file that does not parse', async () => {
    await writeFile(join(dir, 'site-to-api.config.json'), '{\n  "probe": { "maxRps": 2, }\n}\n')
    const error = String(await loadConfig({ cwd: dir }).catch((caught: unknown) => caught))
    expect(error).toMatch(/config\.json: Expected double-quoted property name/)
    expect(error).toContain('  1 | {\n  2 |   "probe": { "maxRps": 2, }\n    |                           ^')
    await rm(join(dir, 'site-to-api.config.json'))
    await writeFile(join(dir, 'site-to-api.config.ts'), 'export default {\n  probe: { maxRps: 2 }\n  outDir: \'x\',\n}\n')
    const code = String(await loadConfig({ cwd: dir }).catch((caught: unknown) => caught))
    expect(code).toContain('  3 |   outDir: \'x\',\n    |   ^')
  })

  it('loads a config that imports defineConfig from site-to-api, even without a local install', async () => {
    // The temp project has no node_modules: the import must resolve to the running copy.
    await writeFile(join(dir, 'site-to-api.config.ts'), `
      import { defineConfig } from 'site-to-api'
      export default defineConfig({ outDir: 'typed' })
    `)
    const { config } = await loadConfig({ cwd: dir })
    expect(config.outDir).toBe('typed')
    // Legitimately heavy: jiti transpiles the TypeScript config and resolves the running copy of
    // site-to-api. ~360 ms alone, 5 s+ when the machine is saturated, so it gets an explicit budget.
  }, 30_000)

  it('with code: false, never runs a .ts or .js config and reads only the JSON one', async () => {
    const marker = join(dir, 'ran.txt')
    await writeFile(join(dir, 'site-to-api.config.ts'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default { outDir: 'from-code' }\n`)
    const plain = await loadConfig({ cwd: dir, code: false })
    expect(plain).toMatchObject({
      file: null,
      ignored: join(dir, 'site-to-api.config.ts'),
      config: { outDir: 'api-handoff' },
    })
    await writeFile(join(dir, 'site-to-api.config.json'), JSON.stringify({ outDir: 'from-json' }))
    expect(await loadConfig({ cwd: dir, code: false })).toMatchObject({
      file: join(dir, 'site-to-api.config.json'),
      config: { outDir: 'from-json' },
    })
    expect(await loadConfig({ cwd: dir, code: false, configFile: 'site-to-api.config.ts' })).toMatchObject({
      file: null,
      config: { outDir: 'api-handoff' },
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('fails clearly for a missing explicit config file', async () => {
    await expect(loadConfig({ cwd: dir, configFile: 'nope.config.ts' })).rejects.toThrow(/Config file not found/)
  })
})
