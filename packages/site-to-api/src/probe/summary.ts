/**
 * What a probe run concluded, in words: printed at the end of `probe` and used for the AGENT.md
 * gaps, so limits such as `probe.minimizePerHost` are visible instead of only showing up as
 * `requires: null` in `probe.json`.
 */
import type { OperationProbe, ProbeReport } from '../model/probe'

/** Reports written before `minimizePerHost` was recorded used this limit. */
const LEGACY_MINIMIZE_PER_HOST = 5

/**
 * What happened to one replayed operation: `bare` worked with no cookies or auth (`requires` is
 * `[]`), `minimized` had its needs worked out one by one, `limit` worked as captured but its host
 * had used up `minimizePerHost`, `once` is a data-changing method sent once and not repeated,
 * `rejected` means the captured session was not accepted any more, `unreachable` that the host
 * could not be reached.
 */
export type ProbeResultKind = 'bare' | 'minimized' | 'limit' | 'once' | 'rejected' | 'unreachable'

/** Classifies one entry of `probe.json`. */
export function probeResultKind(probe: OperationProbe): ProbeResultKind {
  if (probe.replay === 'failed')
    return 'unreachable'
  if (probe.requires !== null) {
    return probe.requires.length === 0
      ? 'bare'
      : 'minimized'
  }
  if (probe.bare === 'skipped')
    return 'once'
  if (probe.replay !== 'ok')
    return 'rejected'
  return 'limit'
}

/** The per-host minimization limit the report was written with. */
export function minimizeLimit(report: ProbeReport): number {
  return report.minimizePerHost ?? LEGACY_MINIMIZE_PER_HOST
}

/**
 * Operations that replayed fine but were not minimized because their host hit the limit. With
 * `current` (the operations of the build now being written), only those still in it: `probe.json`
 * outlives builds, and a host excluded since or an operation renamed by a new capture must not
 * show up as a gap the rest of the folder knows nothing about.
 */
export function notMinimized(
  report: ProbeReport,
  current?: ReadonlyArray<{ host: string, operationId: string }>,
): Array<{ host: string, operationId: string }> {
  const keep = current && new Set(current.map(operation => `${operation.host} ${operation.operationId}`))
  return report.operations
    .filter(probe => probeResultKind(probe) === 'limit')
    .filter(probe => !keep || keep.has(`${probe.host} ${probe.operationId}`))
    .map(probe => ({ host: probe.host, operationId: probe.operationId }))
}

function list(ids: string[]): string {
  return [...ids].sort().join(', ')
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1
    ? ''
    : 's'}`
}

/**
 * Lines for the end of `probe`: how many operations were probed, minimized, not minimized and
 * why, and which were skipped and why. Deterministic for the same report.
 */
export function summarizeProbe(report: ProbeReport): string[] {
  const byKind = new Map<ProbeResultKind, string[]>()
  for (const probe of report.operations) {
    byKind.set(probeResultKind(probe), [
      ...(byKind.get(probeResultKind(probe)) ?? []),
      probe.operationId,
    ])
  }
  const ids = (kind: ProbeResultKind): string[] => byKind.get(kind) ?? []
  const limit = minimizeLimit(report)

  const lines = [
    `Probed ${count(report.operations.length, 'operation')}, skipped ${report.skipped.length}.`,
    `- Needs found: ${ids('minimized').length + ids('bare').length} (${ids('bare').length} work with no cookies or auth; ${ids('minimized').length} worked out one cookie or header at a time).`,
  ]
  const limited = ids('limit')
  if (limited.length > 0)
    lines.push(`- Not minimized, limit of ${limit} per host reached (probe.minimizePerHost): ${limited.length} (${list(limited)}). Run again with --minimize-per-host ${limit + limited.length} to test them.`)
  if (ids('once').length > 0)
    lines.push(`- Not minimized, data-changing method replayed once only: ${ids('once').length} (${list(ids('once'))}).`)
  if (ids('rejected').length > 0)
    lines.push(`- Not minimized, the captured session was not accepted any more: ${ids('rejected').length} (${list(ids('rejected'))}). Capture again shortly before probing.`)
  if (ids('unreachable').length > 0)
    lines.push(`- Not minimized, host unreachable: ${ids('unreachable').length} (${list(ids('unreachable'))}).`)

  const reasons = new Map<string, string[]>()
  for (const entry of report.skipped) {
    reasons.set(entry.reason, [
      ...(reasons.get(entry.reason) ?? []),
      entry.operationId,
    ])
  }
  for (const [reason, skipped] of [...reasons].sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`- Skipped, ${reason}: ${skipped.length} (${list(skipped)}).`)
  return lines
}
