/**
 * `check`: replays the safe operations of a capture against the live site and compares each
 * answer with the operation's response schema, to catch API drift (decision 0044). It reuses
 * probe's replay, so it is as polite and as safe: safe methods only, rate limited, the tool's own
 * user agent, bot-protection steps skipped, and never `--unsafe-methods`.
 */
import type { ResolvedConfig } from '../config/schema'
import type { Operation } from '../model'
import type { CheckReport, OperationCheck } from '../model/check'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { dirname, join } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'
import { CHECK_FORMAT_VERSION, CheckReportSchema } from '../model/check'
import { createReplayer } from '../probe'
import { compareLive, unreachableCheck, withStaleInputs } from './compare'

export { selectOperations } from './hosts'
export { summarizeCheck } from './summary'
export { volatileInputs } from './volatile'

const CHECK_FILE = 'check.json'

export interface CheckOptions {
  operations: Operation[]
  config: ResolvedConfig['probe']
  toolVersion: string
  /** Only these operation ids; an id that matches nothing is an error. */
  operationIds?: string[]
  /** Third-party hosts left out of `operations`, recorded in the report. */
  skippedHosts?: string[]
  /** Per operation id, request inputs that go stale (see `volatileInputs`); a drift verdict on them is `unchecked`. */
  staleInputs?: ReadonlyMap<string, readonly string[]>
  /** Redacts text that may carry a value (field names are data on some sites). */
  redactText?: (text: string) => string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/**
 * `1` when anything drifted (a finding beats a gap). Else `2` when a replayed operation could not
 * be judged: blocked, unreachable, or answered with a status the capture documents nothing for;
 * or when nothing was replayed at all, since "no drift" would then claim more than was looked at.
 * Operations skipped by probe's safety rules, or because the capture holds no success to replay
 * (decision 0052), were never replayed: the summary notes them, and they do not count. An answer
 * that varies by request by nature (`varies`) is neither drift nor a gap. Else `0`.
 */
export function exitCodeFor(operations: readonly OperationCheck[]): 0 | 1 | 2 {
  if (operations.some(entry => entry.verdict === 'drift'))
    return 1
  return operations.length === 0 || operations.some(entry => entry.verdict !== 'ok' && entry.verdict !== 'varies')
    ? 2
    : 0
}

function byCodeUnits(a: string, b: string): number {
  if (a === b)
    return 0
  return a < b
    ? -1
    : 1
}

/** Replays every selected operation once and reports how the live answers differ from the capture. */
export async function checkOperations(options: CheckOptions): Promise<CheckReport> {
  const known = new Set(options.operations.map(operation => operation.operationId))
  const unknown = (options.operationIds ?? []).filter(id => !known.has(id))
  if (unknown.length > 0)
    throw new SiteToApiError(`No operation named ${unknown.join(', ')}. See API_MAP.md in the handoff folder for the operation ids.`)
  const selected = options.operationIds === undefined || options.operationIds.length === 0
    ? options.operations
    : options.operations.filter(operation => options.operationIds?.includes(operation.operationId))

  const redact = options.redactText ?? (text => text)
  const replay = createReplayer({
    config: options.config,
    toolVersion: options.toolVersion,
    fetch: options.fetch,
    now: options.now,
    sleep: options.sleep,
  })
  const operations: OperationCheck[] = []
  const skipped: CheckReport['skipped'] = []
  const ordered = [...selected].sort((a, b) => byCodeUnits(a.host, b.host) || byCodeUnits(a.operationId, b.operationId))
  for (const operation of ordered) {
    options.log?.(`check ${operation.method} ${operation.path}`)
    const live = await replay(operation)
    if (live.kind === 'skipped') {
      skipped.push({
        operationId: operation.operationId,
        reason: redact(live.reason),
        cause: live.cause,
      })
    }
    else if (live.kind === 'unreachable') {
      // The captured status is what the check would have compared with; the first 2xx stands in.
      const expected = operation.responses.find(response => response.status >= 200 && response.status < 300)?.status ?? 200
      operations.push(unreachableCheck(operation, expected, redact(live.error)))
    }
    else {
      operations.push(withStaleInputs(compareLive(operation, live, redact), (options.staleInputs?.get(operation.operationId) ?? []).map(redact)))
    }
  }

  const report: CheckReport = {
    formatVersion: CHECK_FORMAT_VERSION,
    generatedBy: `site-to-api ${options.toolVersion}`,
    checkedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    maxRps: options.config.maxRps,
    skippedHosts: [
      ...options.skippedHosts ?? [],
    ].sort(),
    exitCode: exitCodeFor(operations),
    operations,
    skipped,
  }
  return report
}

/** Writes `check.json` (field paths only, safe to commit) atomically. */
export async function writeCheckReport(outDir: string, report: CheckReport): Promise<string> {
  const path = join(outDir, CHECK_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(CheckReportSchema.parse(report), null, 2)}\n`)
  await rename(temporary, path)
  return path
}

/** Reads `check.json` if present; `null` when `check` has not been run. */
export async function readCheckReport(outDir: string): Promise<CheckReport | null> {
  const path = join(outDir, CHECK_FILE)
  if (!existsSync(path))
    return null
  const invalid = (detail: string, cause?: unknown): SiteToApiError =>
    new SiteToApiError(`${path} is not a valid check report (${detail}). Delete it and run \`site-to-api check\` again.`, { cause })
  let data: unknown
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw invalid('not valid JSON', error)
  }
  const parsed = CheckReportSchema.safeParse(data)
  if (!parsed.success)
    throw invalid(z.prettifyError(parsed.error).replace(/\s+/g, ' '))
  return parsed.data
}
