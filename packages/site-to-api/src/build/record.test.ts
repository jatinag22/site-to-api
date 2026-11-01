import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema'
import { buildRecordFor, mcpChoice, readBuildRecord, recordClientGenerated, stickyOptions, writeBuildRecord } from './record'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-record-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const config = ConfigSchema.parse({
  hosts: {
    include: ['*.shop.test'],
  },
  redact: { examples: 'none' },
  gen: { client: false },
})

describe('build.json', () => {
  it('records effective options and marks flag and env values as sticky', () => {
    const record = buildRecordFor(config, {
      'redact.examples': 'flag',
      'gen.client': 'env',
      'hosts.include': 'file',
      'hosts.exclude': 'default',
    }, '1.2.3')
    expect(record).toEqual({
      clientDir: 'client',
      formatVersion: 1,
      generatedBy: 'site-to-api 1.2.3',
      examples: 'none',
      hosts: {
        include: ['*.shop.test'],
        exclude: [],
      },
      client: false,
      mcp: 'off',
      sticky: ['gen.client', 'redact.examples'],
    })
  })

  it('keeps a --mcp choice for probe, and reads records written before gen.mcp existed', async () => {
    const record = buildRecordFor(ConfigSchema.parse({
      gen: { mcp: 'write' },
    }), { 'gen.mcp': 'flag' }, 'test')
    expect(stickyOptions(record)).toMatchObject({
      gen: { mcp: 'write' },
      described: ['--mcp write'],
    })
    const { mcp: _mcp, ...older } = record
    await writeFile(join(dir, 'build.json'), JSON.stringify({ ...older, sticky: [] }))
    expect((await readBuildRecord(dir))?.mcp).toBeUndefined()
    // gen --mcp read records what it wrote, sticky because a flag chose it.
    await recordClientGenerated(dir, {
      mcp: { mode: 'read', sticky: true },
    })
    expect(await readBuildRecord(dir)).toMatchObject({
      mcp: 'read',
      sticky: ['gen.mcp'],
    })
    await recordClientGenerated(dir, {
      mcp: { mode: 'off', sticky: false },
    })
    expect(await readBuildRecord(dir)).toMatchObject({ mcp: 'off', sticky: [] })
  })

  it('turns sticky options into config flags and a readable list', () => {
    const record = buildRecordFor(config, { 'redact.examples': 'flag', 'gen.client': 'flag', 'hosts.include': 'flag' }, 'test')
    expect(stickyOptions(record)).toEqual({
      hosts: {
        include: ['*.shop.test'],
      },
      redact: { examples: 'none' },
      gen: { client: false },
      described: ['--include *.shop.test', '--examples none', '--no-client'],
    })
    // A value set now by an environment variable or flag is not overridden by the last build.
    expect(stickyOptions(record, { 'redact.examples': 'env', 'gen.client': 'flag', 'hosts.include': 'file' })).toEqual({
      hosts: {
        include: ['*.shop.test'],
      },
      redact: {},
      gen: {},
      described: ['--include *.shop.test'],
    })
    expect(stickyOptions(null)).toEqual({
      hosts: {},
      redact: {},
      gen: {},
      described: [],
    })
  })

  it('round-trips, and gen drops a sticky --no-client', async () => {
    expect(await readBuildRecord(dir)).toBeNull()
    await writeBuildRecord(dir, buildRecordFor(config, { 'redact.examples': 'flag', 'gen.client': 'flag' }, 'test'))
    await recordClientGenerated(dir)
    expect(await readBuildRecord(dir)).toMatchObject({
      client: true,
      sticky: ['redact.examples'],
    })
    expect(await readFile(join(dir, 'build.json'), 'utf8')).toMatch(/\n$/)
  })

  it('records the generated client files and their hashes (decision 0058)', async () => {
    await writeBuildRecord(dir, buildRecordFor(config, {}, 'test', {
      generated: { 'index.ts': 'a1' },
    }))
    expect((await readBuildRecord(dir))?.generated).toEqual({ 'index.ts': 'a1' })
    await recordClientGenerated(dir, {
      generated: { 'index.ts': 'b2', 'README.md': 'c3' },
      clientDir: '../app/client',
    })
    expect(await readBuildRecord(dir)).toMatchObject({
      generated: { 'index.ts': 'b2', 'README.md': 'c3' },
      clientDir: '../app/client',
    })
  })

  it('explains what to do with a broken file', async () => {
    await writeFile(join(dir, 'build.json'), '{"formatVersion": 1')
    await expect(readBuildRecord(dir)).rejects.toThrow(/not valid JSON.*site-to-api build/)
    await writeFile(join(dir, 'build.json'), '{"formatVersion": 2}')
    await expect(readBuildRecord(dir)).rejects.toThrow(/not a build record/)
  })
})

describe('mcpChoice (decision 0058)', () => {
  const withServer = {
    ...buildRecordFor(config, {}, 'test', {
      generatedMcp: { 'server.ts': 'a1' },
    }),
    mcp: 'write' as const,
  }

  it('keeps the MCP server gen wrote when nothing sets gen.mcp', () => {
    expect(mcpChoice(config, { 'gen.mcp': 'default' }, withServer)).toEqual({ mode: 'write', kept: true })
    expect(mcpChoice(config, undefined, withServer)).toEqual({ mode: 'write', kept: true })
  })

  it('follows gen.mcp once something sets it, and keeps off when no server was written', () => {
    expect(mcpChoice(config, { 'gen.mcp': 'flag' }, withServer)).toEqual({ mode: 'off', kept: false })
    expect(mcpChoice(config, { 'gen.mcp': 'file' }, withServer)).toEqual({ mode: 'off', kept: false })
    expect(mcpChoice(config, { 'gen.mcp': 'default' }, { ...withServer, generatedMcp: {} })).toEqual({ mode: 'off', kept: false })
    expect(mcpChoice(config, { 'gen.mcp': 'default' }, null)).toEqual({ mode: 'off', kept: false })
  })
})

describe('generated paths in build.json (decision 0058)', () => {
  it('refuses a record whose generated files leave their folder', async () => {
    const record = buildRecordFor(config, {}, 'test')
    await writeFile(join(dir, 'build.json'), JSON.stringify({
      ...record,
      generated: { '../../../secret.env': 'x' },
    }))
    await expect(readBuildRecord(dir)).rejects.toThrow(/Invalid key in record;\s+→ at generated\["\.\.\/\.\.\/\.\.\/secret\.env"\]/)
    await writeFile(join(dir, 'build.json'), JSON.stringify({
      ...record,
      generatedMcp: { '/etc/hosts': 'x' },
    }))
    await expect(readBuildRecord(dir)).rejects.toThrow(/Invalid key in record;\s+→ at generatedMcp\["\/etc\/hosts"\]/)
  })
})
