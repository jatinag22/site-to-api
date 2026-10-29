/**
 * Folds probe results into the session requirements that `flows.json` and `AGENT.md` report, so
 * "needs a browser" is a measured fact where probing was possible, not only an inference.
 */
import type { Operation, SessionRequirement } from '../model'
import type { ProbeReport } from '../model/probe'
import { cookieNeedsBrowser } from '../model'

/** Request headers that bot-protection scripts compute in the page; a wrapper cannot make them. */
const BROWSER_HEADERS = /^header:(?:x-kpsdk-|x-px-|x-acf-sensor-data$|x-dd-b$)/

/**
 * The host verdict from the probe results of its operations. It follows what probe measured: a
 * host where every tested request works without cookies is plain HTTP even when the capture saw
 * bot-protection cookies on its pages.
 */
function requirementFor(entry: SessionRequirement, probes: ProbeReport['operations']): SessionRequirement['requires'] {
  const tested = probes.filter(probe => probe.replay === 'ok')
  if (tested.length === 0)
    return entry.requires
  if (tested.every(probe => probe.bare === 'ok'))
    return 'none'
  const minimized = tested.filter(probe => probe.requires !== null)
  const needed = new Set(minimized.flatMap(probe => probe.requires ?? []))
  // Only opaque, browser-made cookies need a browser; a derivable script-set one (`script`) only
  // needs the wrapper to set it, like any other cookie.
  const browserCookies = new Set(entry.cookies.filter(cookieNeedsBrowser).map(cookie => `cookie:${cookie.name}`))
  if ([...needed].some(item => browserCookies.has(item) || BROWSER_HEADERS.test(item)))
    return 'browser'
  if (needed.has('header:authorization'))
    return 'token'
  if ([...needed].some(item => item.startsWith('cookie:')))
    return 'cookies'
  // Every tested request was worked out and none needs a cookie, a token or a browser-made value.
  if (minimized.length === tested.length)
    return 'none'
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

/**
 * Hosts that served only pages (no `api` operation), which the session requirements of
 * `flows.json` do not cover. AGENT.md still gives each one a section: the main host of a
 * server-rendered site is often one of them. The verdict is inferred from the cookies the pages
 * were requested with, then corrected by probe like any other host.
 */
export function pageHostRequirements(operations: readonly Operation[], session: readonly SessionRequirement[], report: ProbeReport | null): SessionRequirement[] {
  const covered = new Set(session.map(entry => entry.host))
  const hosts = [
    ...new Set(operations.filter(operation => !operation.sourceOnly && !covered.has(operation.host)).map(operation => operation.host)),
  ].sort()
  const entries = hosts.map((host): SessionRequirement => ({
    host,
    requires: operations.some(operation => operation.host === host && operation.cookies.length > 0)
      ? 'cookies'
      : 'none',
    cookies: [],
    botProtection: [],
    probed: false,
  }))
  return report
    ? applyProbeReport(entries, report)
    : entries
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
