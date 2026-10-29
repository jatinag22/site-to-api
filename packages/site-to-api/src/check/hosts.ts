/**
 * Which hosts `check` replays (decision 0044). A site's drift matters on its own hosts; a third
 * party (Google sign-in, an ad network) changes on its own schedule and is none of the wrapper's
 * business, yet one of its operations would decide the exit code. So by default only the site's
 * own hosts are checked, the same "first-party" hosts `AGENT.md` lists first. A host is opted in
 * by naming it with `--include`, or by naming one of its operations with `--operations`.
 */
import type { Analysis, Operation } from '../model'
import { compileHostGlobs } from '../analyze/classify'
import { rankHosts } from '../emit/handoff/importance'

export interface HostSelection {
  /** The operations to check. */
  operations: Operation[]
  /** Third-party hosts that have operations but were not selected, sorted. */
  skippedHosts: string[]
}

export interface HostFlags {
  include?: string[]
  exclude?: string[]
  operationIds?: string[]
}

/** Picks the operations to check from an analysis by host role and the `--include`/`--exclude` globs. */
export function selectOperations(analysis: Analysis, flags: HostFlags): HostSelection {
  const roles = new Map(rankHosts(analysis, []).map(entry => [entry.host, entry.role]))
  const include = flags.include ?? []
  const excluded = compileHostGlobs(flags.exclude ?? [])
  const included = compileHostGlobs(include)
  const named = new Set(flags.operationIds ?? [])
  const wanted = (operation: Operation): boolean => {
    if (excluded(operation.host))
      return false
    if (named.has(operation.operationId))
      return true
    return include.length > 0
      ? included(operation.host)
      : roles.get(operation.host) !== 'third-party'
  }
  const operations = analysis.operations.filter(wanted)
  const chosen = new Set(operations.map(operation => operation.host))
  const skippedHosts = [
    ...new Set(analysis.operations
      .filter(operation => roles.get(operation.host) === 'third-party' && !chosen.has(operation.host) && !excluded(operation.host))
      .map(operation => operation.host)),
  ].sort()
  return { operations, skippedHosts }
}
