import type { ProbeReport } from '../model/probe'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'
import { ProbeReportSchema } from '../model/probe'

export { alignProbeReport, applyProbeReport, browserOnlyCalls, pageHostRequirements, requirementsByOperation } from './apply'
export { createReplayer, probeOperations } from './probe'
export type { LiveReplay, ProbeOptions } from './probe'
export { minimizeLimit, notMinimized, probeFailures, summarizeProbe } from './summary'

const PROBE_FILE = 'probe.json'

/** Writes `probe.json` (names only, safe to commit) atomically, so an interrupted run never leaves half a file. */
export async function writeProbeReport(outDir: string, report: ProbeReport): Promise<string> {
  const path = join(outDir, PROBE_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(ProbeReportSchema.parse(report), null, 2)}\n`)
  await rename(temporary, path)
  return path
}

/** Reads `probe.json` if present; `null` when probing has not been run. */
export async function readProbeReport(outDir: string): Promise<ProbeReport | null> {
  const path = join(outDir, PROBE_FILE)
  if (!existsSync(path))
    return null
  const invalid = (detail: string, cause?: unknown): SiteToApiError =>
    new SiteToApiError(`${path} is not a valid probe report (${detail}). Delete it and run \`site-to-api probe\` again.`, { cause })
  let data: unknown
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw invalid('not valid JSON', error)
  }
  const parsed = ProbeReportSchema.safeParse(data)
  if (!parsed.success)
    throw invalid(z.prettifyError(parsed.error).replace(/\s+/g, ' '))
  return parsed.data
}
