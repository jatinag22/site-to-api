/**
 * Folds probe results into the session requirements that `flows.json` and `AGENT.md` report, so
 * "needs a browser" is a measured fact where probing was possible, not only an inference.
 */
import type { Exchange, Operation, SessionRequirement } from '../model'
import type { OperationProbe, ProbeReport } from '../model/probe'
import { isBotProtectionHeader, sendsBotProtectionHeaders } from '../analyze/classify'
import { botProtectionVendor } from '../analyze/correlate'
import { ANALYTICS_COOKIE } from '../analyze/flows'
import { redactRequirement } from '../analyze/redact'
import { cookieNeedsBrowser } from '../model'

/** The operations of the build being written, to match `probe.json` entries against. */
type CurrentOperation = Pick<Operation, 'host' | 'operationId' | 'kind' | 'headers' | 'cookies'>

/**
 * Re-labels each probe entry with the operation of this build that holds the exchange it
 * replayed. `probe.json` outlives builds: when path templating later merges
 * `/fragments/async-chat` and `/fragments/error-modal` into `/fragments/{slug}`, the entries
 * still name `getFragmentsAsyncChat`, and matching by id alone would leave the merged operation
 * untested. Entries whose exchange is gone keep their id. Inputs are not modified.
 */
export function alignProbeReport(report: ProbeReport, operations: ReadonlyArray<Pick<Operation, 'host' | 'operationId'> & { exchanges: ReadonlyArray<Pick<Exchange, 'id'>> }>): ProbeReport {
  const owner = new Map<string, Pick<Operation, 'host' | 'operationId'>>()
  for (const operation of operations) {
    for (const exchange of operation.exchanges)
      owner.set(exchange.id, operation)
  }
  return {
    ...report,
    operations: report.operations.map((probe) => {
      const current = owner.get(probe.exchangeId)
      return current && current.host === probe.host
        ? { ...probe, operationId: current.operationId }
        : probe
    }),
  }
}

/**
 * True when an untested call may still depend on the bot-protection vendor: it sends a vendor
 * cookie that no tested call of the host was captured with and still answered bare. A vendor
 * cookie the browser attaches to every request of the domain (Akamai's `ak_bmsc` and `bm_sv` on
 * Nike) is shown unneeded by any tested call that carried it and worked without it. Vendor
 * headers are left out on purpose: the script adds them to particular calls, so such a call is
 * named on its own (`browserOnlyCalls`) instead of deciding the whole host (decision 0046).
 */
function sendsUnprovenVendorCookie(operation: CurrentOperation, provenUnneeded: ReadonlySet<string>): boolean {
  return operation.cookies.some(cookie => botProtectionVendor(cookie.name) !== null && !provenUnneeded.has(cookie.name))
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
  // Calls probe could not test (a PUT, no successful sample) that send a vendor cookie no tested
  // call showed to be unneeded still need the browser, however well the tested ones did bare.
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
  // headers, listed in `x-site-to-api-requires` (decision 0036). An untested call sending an
  // unproven vendor cookie keeps the inferred verdict; failures are handled in applyProbeReport.
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
 * with bot protection keeps `browser` while a call probe did not test sends a vendor cookie that no
 * tested call proved unneeded; a call that sends vendor headers is named by `browserOnlyCalls`
 * and leaves the host's verdict to the tested calls (decision 0046). Align `report` with
 * `alignProbeReport` first. `redactName` is the spelling `probe.json` uses for names that carry values.
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
    const hostOperations = operations.filter(operation => operation.host === entry.host && operation.kind === 'api')
    const bareOk = new Set(probes.filter(probe => probe.replay === 'ok' && probe.bare === 'ok').map(probe => probe.operationId))
    const provenUnneeded = new Set(hostOperations
      .filter(operation => bareOk.has(operation.operationId))
      .flatMap(operation => operation.cookies.map(cookie => cookie.name)))
    const guardedUntested = hostOperations.some(operation => !tested.has(operation.operationId)
      && sendsUnprovenVendorCookie(operation, provenUnneeded))
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

/**
 * Per `<host> <operationId>`, the needs probe removed one at a time (`tested`), so only these can
 * be called not needed. Older reports without `tested` give nothing.
 */
export function testedByOperation(report: ProbeReport): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const probe of report.operations) {
    if (probe.tested === undefined)
      continue
    const key = `${probe.host} ${probe.operationId}`
    result.set(key, [
      ...new Set([
        ...result.get(key) ?? [],
        ...probe.tested,
      ]),
    ].sort())
  }
  return result
}

/**
 * `x-site-to-api-requires` per operation: what probing showed each request needs. Several
 * entries can name one operation after `alignProbeReport` (paths merged into one template); the
 * operation then needs everything any of them needed.
 */
export function requirementsByOperation(report: ProbeReport): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const probe of report.operations) {
    if (probe.requires === null)
      continue
    const key = `${probe.host} ${probe.operationId}`
    result.set(key, [
      ...new Set([
        ...result.get(key) ?? [],
        ...probe.requires,
      ]),
    ].sort())
  }
  return result
}

/**
 * The calls of a host that only a real browser can make although the host's verdict is plain
 * HTTP: they send headers a bot-protection script computes (Kasada's `x-kpsdk-*` on Nike's cart
 * `PUT`), and probe did not show them working without those headers. Empty when the host itself
 * needs a browser, since its verdict already says so.
 */
export function browserOnlyCalls(entry: Pick<SessionRequirement, 'host' | 'requires' | 'botProtection'>, operations: ReadonlyArray<Pick<Operation, 'host' | 'operationId' | 'kind' | 'headers' | 'requires'>>): string[] {
  if (entry.requires === 'browser' || entry.botProtection.length === 0)
    return []
  return operations
    .filter(operation => operation.host === entry.host
      && operation.kind === 'api'
      && sendsBotProtectionHeaders(operation)
      && !(Array.isArray(operation.requires) && !operation.requires.some(item => item.startsWith('header:') && isBotProtectionHeader(item.slice('header:'.length)))))
    .map(operation => operation.operationId)
    .sort()
}
