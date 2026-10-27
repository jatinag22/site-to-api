/**
 * Folds probe results into the session requirements that `flows.json` and `AGENT.md` report, so
 * "needs a browser" is a measured fact where probing was possible, not only an inference.
 */
import type { SessionRequirement } from '../model'
import type { ProbeReport } from '../model/probe'
import { cookieNeedsBrowser } from '../model'

function requirementFor(entry: SessionRequirement, probes: ProbeReport['operations']): SessionRequirement['requires'] {
  const tested = probes.filter(probe => probe.replay === 'ok')
  if (tested.length === 0)
    return entry.requires
  if (tested.every(probe => probe.bare === 'ok'))
    return 'none'
  const needed = new Set(tested.flatMap(probe => probe.requires ?? []))
  // Only opaque, browser-made cookies need a browser; a derivable script-set one (`script`) only
  // needs the wrapper to set it, like any other cookie.
  const browserCookies = new Set(entry.cookies.filter(cookieNeedsBrowser).map(cookie => `cookie:${cookie.name}`))
  if (entry.botProtection.length > 0 || [...needed].some(item => browserCookies.has(item)))
    return 'browser'
  if (needed.has('header:authorization'))
    return 'token'
  if ([...needed].some(item => item.startsWith('cookie:')))
    return 'cookies'
  return entry.requires
}

/** Returns new session requirements with probe evidence applied. Inputs are not modified. */
export function applyProbeReport(session: SessionRequirement[], report: ProbeReport): SessionRequirement[] {
  return session.map((entry) => {
    const probes = report.operations.filter(probe => probe.host === entry.host)
    const probed = probes.some(probe => probe.replay === 'ok')
    return {
      ...entry,
      requires: requirementFor(entry, probes),
      probed,
    }
  })
}

/** `x-site-to-api-requires` per operation: what probing showed each request needs. */
export function requirementsByOperation(report: ProbeReport): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const probe of report.operations) {
    if (probe.requires !== null)
      result.set(`${probe.host} ${probe.operationId}`, probe.requires)
  }
  return result
}
