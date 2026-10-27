import type { ProbeReport } from '../model/probe'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'
import { ProbeReportSchema } from '../model/probe'

export { applyProbeReport, requirementsByOperation } from './apply'
export { probeOperations } from './probe'
export type { ProbeOptions } from './probe'

export const PROBE_FILE = 'probe.json'

/** Writes `probe.json` (names only, safe to commit) into the handoff folder. */
export async function writeProbeReport(outDir: string, report: ProbeReport): Promise<string> {
  const path = join(outDir, PROBE_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(ProbeReportSchema.parse(report), null, 2)}\n`)
  return path
}

/** Reads `probe.json` if present; `null` when probing has not been run. */
export async function readProbeReport(outDir: string): Promise<ProbeReport | null> {
  const path = join(outDir, PROBE_FILE)
  if (!existsSync(path))
    return null
  const parsed = ProbeReportSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!parsed.success)
    throw new SiteToApiError(`${path} is not a valid probe report:\n${z.prettifyError(parsed.error)}\nDelete it and run \`site-to-api probe\` again.`)
  return parsed.data
}
