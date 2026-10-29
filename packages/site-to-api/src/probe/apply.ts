/**
 * Folds probe results into the session requirements that `flows.json` and `AGENT.md` report, so
 * "needs a browser" is a measured fact where probing was possible, not only an inference.
 */
import type { Operation, SessionRequirement } from '../model'
import type { OperationProbe, ProbeReport } from '../model/probe'
import { isBotProtectionHeader, sendsBotProtectionHeaders } from '../analyze/classify'
import { botProtectionVendor } from '../analyze/correlate'
import { ANALYTICS_COOKIE } from '../analyze/flows'
import { redactRequirement } from '../analyze/redact'
import { cookieNeedsBrowser } from '../model'

/** The operations of the build being written, to match `probe.json` entries against. */
type CurrentOperation = Pick<Operation, 'host' | 'operationId' | 'kind' | 'headers' | 'cookies'>

/** True when a call carries what a bot-protection script makes: its headers or its cookies. */
function sendsBotProtectionTraces(operation: CurrentOperation): boolean {
  return sendsBotProtectionHeaders(operation) || operation.cookies.some(cookie => botProtectionVendor(cookie.name) !== null)
}

/**
 * True when the probe worked out what a request needs: it worked bare, or removing items one by
 * one found a non-empty set of needs. A rejected bare replay with no needs found (nothing was
 * minimized, or every single removal still worked) leaves the question open.
 */
function resolved(probe: OperationProbe): boolean {
  return probe.bare === 'ok' || (probe.requires !== null && probe.requires.length > 0)
}

function requirementFor(entry: SessionRequirement, probes: OperationProbe[], guardedUntested: boolean, redactName: (name: string) => string): SessionRequirement['requires'] {
  const tested = probes.filter(probe => probe.replay === 'ok')
  if (tested.length === 0)
    return entry.requires
  // Calls probe could not test (a PUT, no successful sample) that send bot-protection headers or
  // cookies still need the browser, however well the tested ones did bare.
  if (guardedUntested && entry.botProtection.length > 0)
    return 'browser'
  if (tested.every(probe => probe.bare === 'ok'))
    return 'none'
  // probe.json may hold redacted names (`cookie:<redacted: UUID>...`): compare in that spelling.
  const needed = new Set(tested.flatMap(probe => probe.requires ?? []).map(item => redactRequirement(item, redactName)))
  // Only opaque, browser-made cookies and bot-protection headers need a browser; a derivable
  // script-set cookie (`script`) only needs the wrapper to set it, like any other cookie.
  const browserCookies = new Set(entry.cookies.filter(cookieNeedsBrowser).map(cookie => `cookie:${redactName(cookie.name)}`))
  const needsBrowser = [...needed].some(item => browserCookies.has(item)
    || (item.startsWith('header:') && isBotProtectionHeader(item.slice('header:'.length))))
  const open = tested.some(probe => !resolved(probe))
  if (needsBrowser || (open && entry.botProtection.length > 0))
    return 'browser'
  if (needed.has('header:authorization'))
    return 'token'
  if ([...needed].some(item => item.startsWith('cookie:')))
    return 'cookies'
  // Every tested call was worked out and needed only plain headers: plain HTTP with those
  // headers, listed in `x-site-to-api-requires` (decision 0036). An untested call sending vendor
  // traces keeps the inferred verdict; failures are handled in applyProbeReport.
  if (!open && !guardedUntested)
    return 'none'
  return entry.requires
}

/**
 * Returns new session requirements with probe evidence applied. Inputs are not modified.
 *
 * Only probes of the host's real operations in `operations` count: a bot-protection step replayed
 * by an older probe (or one classified differently since) is rejected by design and says nothing
 * about the API, and an operation no longer in the build says nothing about it either. A host
 * with bot protection keeps `browser` while a call probe did not test sends the vendor's headers
 * or cookies. `redactName` is the spelling `probe.json` uses for names that carry values.
 */
export function applyProbeReport(session: SessionRequirement[], report: ProbeReport, operations: readonly CurrentOperation[], redactName: (name: string) => string = name => name): SessionRequirement[] {
  const real = new Set(operations
    .filter(operation => operation.kind !== 'bot-protection')
    .map(operation => `${operation.host} ${operation.operationId}`))
  return session.map((entry) => {
    const probes = report.operations.filter(probe => probe.host === entry.host && real.has(`${probe.host} ${probe.operationId}`))
    // One call that worked bare does not confirm a host where other calls were refused, blocked
    // or unreachable: the verdict stays inferred, and never becomes "no session needed".
    const failed = probes.some(probe => probe.replay !== 'ok')
    const tested = new Set(probes.filter(probe => probe.replay === 'ok').map(probe => probe.operationId))
    const guardedUntested = operations.some(operation => operation.host === entry.host
      && operation.kind === 'api'
      && !tested.has(operation.operationId)
      && sendsBotProtectionTraces(operation))
    const measured = requirementFor(entry, probes, guardedUntested, redactName)
    return {
      ...entry,
      requires: failed && measured === 'none'
        ? entry.requires
        : measured,
      probed: !failed && tested.size > 0,
    }
  })
}

/**
 * Hosts that served only pages (no `api` operation), which the session requirements of
 * `flows.json` do not cover. AGENT.md still gives each one a section: the main host of a
 * server-rendered site is often one of them. The verdict is inferred from the cookies the pages
 * were requested with, then corrected by probe like any other host.
 */
export function pageHostRequirements(operations: readonly Operation[], session: readonly SessionRequirement[], report: ProbeReport | null, redactName: (name: string) => string = name => name): SessionRequirement[] {
  const covered = new Set(session.map(entry => entry.host))
  const hosts = [
    ...new Set(operations.filter(operation => !operation.sourceOnly && !covered.has(operation.host)).map(operation => operation.host)),
  ].sort()
  const entries = hosts.map((host): SessionRequirement => ({
    host,
    // Analytics cookies travel with every page request; no page depends on them.
    requires: operations.some(operation => operation.host === host && operation.cookies.some(cookie => !ANALYTICS_COOKIE.test(cookie.name)))
      ? 'cookies'
      : 'none',
    cookies: [],
    botProtection: [],
    probed: false,
  }))
  return report
    ? applyProbeReport(entries, report, operations, redactName)
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
