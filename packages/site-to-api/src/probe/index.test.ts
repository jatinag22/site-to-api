import type { ProbeReport } from '../model/probe'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readProbeReport, writeProbeReport } from './index'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-probe-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const report: ProbeReport = {
  formatVersion: 1,
  generatedBy: 'test',
  probedAt: '2026-01-01T00:00:00.000Z',
  maxRps: 1,
  unsafeMethods: false,
  operations: [],
  skipped: [],
}

describe('probe.json', () => {
  it('round-trips and leaves no temporary file behind', async () => {
    await writeProbeReport(dir, report)
    expect(await readProbeReport(dir)).toEqual(report)
    expect(await readdir(dir)).toEqual(['probe.json'])
  })

  it('returns null before probing', async () => {
    expect(await readProbeReport(dir)).toBeNull()
  })

  it('explains what to do with a truncated or hand-edited file', async () => {
    await writeFile(join(dir, 'probe.json'), '{"formatVersion": 1, "gener')
    await expect(readProbeReport(dir)).rejects.toThrow(/not valid JSON.*Delete it and run `site-to-api probe` again/)
    await writeFile(join(dir, 'probe.json'), '{"formatVersion": 2}')
    await expect(readProbeReport(dir)).rejects.toThrow(/not a valid probe report/)
  })
})
