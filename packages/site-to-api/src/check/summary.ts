import type { CheckReport, OperationCheck } from '../model/check'

function label(entry: OperationCheck): string {
  return `${entry.method} ${entry.host}${entry.path} (${entry.operationId})`
}

function details(entry: OperationCheck): string[] {
  const lines: string[] = []
  if (entry.status.actual !== null && entry.status.actual !== entry.status.expected)
    lines.push(`  status: ${entry.status.expected} -> ${entry.status.actual}`)
  if (entry.added.length > 0)
    lines.push(`  added: ${entry.added.join(', ')}`)
  if (entry.removed.length > 0)
    lines.push(`  removed: ${entry.removed.join(', ')}`)
  for (const change of entry.typeChanged)
    lines.push(`  type: ${change.path} ${change.expected} -> ${change.actual}`)
  return lines
}

/** The lines `check` prints: counts first, then one block per operation that is not ok. */
export function summarizeCheck(report: CheckReport): string[] {
  const count = (verdict: OperationCheck['verdict']): number => report.operations.filter(entry => entry.verdict === verdict).length
  const lines = [
    `Checked ${report.operations.length} operations: ${count('ok')} ok, ${count('drift')} drifted, ${count('blocked')} blocked, ${count('unreachable')} unreachable, ${count('unchecked')} unchecked; ${report.skipped.length} skipped.`,
  ]
  for (const entry of report.operations) {
    if (entry.verdict === 'drift')
      lines.push(`DRIFT ${label(entry)}`, ...details(entry))
    else if (entry.verdict === 'blocked')
      lines.push(`BLOCKED ${label(entry)}`, `  ${entry.note ?? 'refused'}`)
    else if (entry.verdict === 'unchecked')
      lines.push(`UNCHECKED ${label(entry)}`, `  ${entry.note ?? 'nothing to compare with'}`)
    else if (entry.verdict === 'unreachable')
      lines.push(`UNREACHABLE ${label(entry)}`, `  ${entry.note ?? 'no answer'}`)
  }
  const unsampled = report.skipped.filter(entry => entry.cause === 'no-sample')
  for (const entry of unsampled)
    lines.push(`NOT CHECKED ${entry.operationId}`, `  ${entry.reason}`)
  if (unsampled.length > 0 && report.operations.length > 0)
    lines.push(`${unsampled.length} operation(s) had no captured success to replay and were not checked; this does not change the exit code. Capture them working to check them.`)
  if (report.skippedHosts.length > 0)
    lines.push(`Third-party hosts not checked (name one with --include to check it): ${report.skippedHosts.join(', ')}.`)
  if (report.operations.length === 0)
    lines.push('Nothing was replayed. Every operation was skipped (see check.json) or none matched.')
  return lines
}
