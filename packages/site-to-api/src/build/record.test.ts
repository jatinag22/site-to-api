import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema'
import { buildRecordFor, readBuildRecord, recordClientGenerated, stickyOptions, writeBuildRecord } from './record'

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
      formatVersion: 1,
      generatedBy: 'site-to-api 1.2.3',
      examples: 'none',
      hosts: {
        include: ['*.shop.test'],
        exclude: [],
      },
      client: false,
      sticky: ['gen.client', 'redact.examples'],
    })
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

  it('explains what to do with a broken file', async () => {
    await writeFile(join(dir, 'build.json'), '{"formatVersion": 1')
    await expect(readBuildRecord(dir)).rejects.toThrow(/not valid JSON.*site-to-api build/)
    await writeFile(join(dir, 'build.json'), '{"formatVersion": 2}')
    await expect(readBuildRecord(dir)).rejects.toThrow(/not a build record/)
  })
})
