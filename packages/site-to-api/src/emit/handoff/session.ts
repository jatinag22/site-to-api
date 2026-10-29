/**
 * What a host needs from a session: the full lines of `hosts/<host>.md` and the one-line verdict
 * `AGENT.md` gives each host. Vendor names, evidence and cookie names come from the captured site,
 * so each goes through `text()` or `code()` (decision 0019).
 */
import type { Analysis, SessionRequirement } from '../../model'
import type { HostStems } from '../host-files'
import type { StepResolver } from '../steps'
import type { AgentGuideContext, ProbeGaps } from './context'
import { isBotProtectionHeader, isChallengeAnswer, sendsBotProtectionHeaders } from '../../analyze/classify'
import { browserOnlyCalls } from '../../probe'
import { cookieLines } from '../cookies'
import { code, text } from '../escape'
import { specFileName } from '../openapi/write'
import { plural } from './context'

const REQUIREMENT_TEXT: Record<SessionRequirement['requires'], string> = {
  none: 'plain HTTP works; no session needed',
  cookies: 'plain HTTP with a cookie jar',
  token: 'plain HTTP with a bearer token (obtained from a login step)',
  browser: 'a real browser is needed to establish the session; reuse its cookies for plain HTTP calls',
  unknown: 'unknown; run `site-to-api probe` to find out',
}

/** The same verdicts, short enough for one line per host in `AGENT.md`. */
const SHORT_REQUIREMENT: Record<SessionRequirement['requires'], string> = {
  none: 'plain HTTP, no session',
  cookies: 'plain HTTP with a cookie jar',
  token: 'plain HTTP with a bearer token from a login step',
  browser: 'a real browser sets up the session',
  unknown: 'session needs unknown',
}

/** `getRoot`, or `getRoot` on `api.site.com` when another host has an operation with the same id. */
export function operationName(operationId: string, host: string | null, resolver: StepResolver): string {
  return host !== null && resolver.ambiguous(operationId)
    ? `${code(operationId)} on ${code(host)}`
    : code(operationId)
}

/** Operations on the entry's host that `probe` minimized, by their `requires` lists. */
function probedRequires(entry: SessionRequirement, analysis: Analysis): string[][] {
  return analysis.operations.flatMap(operation => operation.host === entry.host && Array.isArray(operation.requires)
    ? [operation.requires]
    : [])
}

/** Where the Needs verdict comes from; never "confirmed" unless a replay of this host worked. */
const FAILURE_LABEL: Record<string, string> = {
  blocked: 'blocked by bot protection',
  rejected: 'session refused',
  differs: 'answered differently',
  unreachable: 'unreachable',
}

/** `2 blocked by bot protection, 1 session refused` for the host's failed probes. */
function failureSummary(host: string, probe: ProbeGaps): string {
  const counts = new Map<string, number>()
  for (const failure of probe.failures.filter(entry => entry.host === host))
    counts.set(failure.kind, (counts.get(failure.kind) ?? 0) + 1)
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${count} ${FAILURE_LABEL[kind] ?? kind}`).join(', ')
}

function verdictSource(entry: SessionRequirement, probe: ProbeGaps | null): string {
  if (entry.probed)
    return 'confirmed by probe'
  if (!probe)
    return 'inferred from the capture, not yet probed'
  const failures = failureSummary(entry.host, probe)
  if (failures !== '')
    return `inferred from the capture; probe could not confirm it: ${failures}; see Gaps`
  return probe.triedHosts.includes(entry.host)
    ? 'inferred from the capture; probe could not confirm it, see Gaps'
    : 'inferred from the capture; probe tested no operation on this host'
}

function shortSource(entry: SessionRequirement, probe: ProbeGaps | null): string {
  if (entry.probed)
    return 'confirmed by probe'
  if (!probe)
    return 'not yet probed'
  return probe.triedHosts.includes(entry.host)
    ? 'probe could not confirm it'
    : 'probe tested nothing here'
}

/** Headers probe found necessary on this host, beyond cookies. */
function neededHeaders(tested: string[][]): string[] {
  return [
    ...new Set(tested.flat().filter(item => item.startsWith('header:')).map(item => item.slice('header:'.length))),
  ].sort()
}

/** The Needs line: the verdict, headers probe found necessary, and where the verdict comes from. */
function needsLine(entry: SessionRequirement, headers: string[], context: AgentGuideContext): string {
  const withHeaders = headers.length > 0
    ? `; requests need ${plural(headers.length, 'header', 'headers')} ${headers.map(code).join(', ')}`
    : ''
  // Probe can find a browser needed for a header a bot-protection script computes, with no cookie
  // involved; say that instead of the cookie advice.
  const browserHeaders = headers.filter(name => isBotProtectionHeader(name))
  const needs = entry.requires === 'browser' && browserHeaders.length > 0
    ? `a real browser is needed: ${browserHeaders.map(code).join(', ')} ${plural(browserHeaders.length, 'is', 'are')} computed by a bot-protection script in the page`
    : entry.requires === 'none' && headers.length > 0
      // Headers are a need of their own: "no session needed" would undersell them.
      ? 'plain HTTP works'
      : REQUIREMENT_TEXT[entry.requires]
  return `- Needs: ${needs}${withHeaders} (${verdictSource(entry, context.probe)}).`
}

/**
 * True when every observed page and call of a host was answered with a challenge (Reddit's
 * "Prove your humanity" on every page): the capture holds nothing of the site itself.
 */
export function servedOnlyChallenges(host: string, analysis: Analysis): boolean {
  const exchanges = analysis.operations
    .filter(operation => operation.host === host && !operation.sourceOnly)
    .flatMap(operation => operation.kind === 'bot-protection' && !operation.exchanges.some(isChallengeAnswer)
      ? []
      : operation.exchanges)
  return exchanges.length > 0 && exchanges.every(isChallengeAnswer)
}

/** True when every observed operation of a host is a bot-protection step at a vendor endpoint. */
export function onlyVendorSteps(host: string, analysis: Analysis): boolean {
  const observed = analysis.operations.filter(operation => operation.host === host && !operation.sourceOnly)
  return observed.length > 0 && observed.every(operation => operation.kind === 'bot-protection' && !operation.exchanges.some(isChallengeAnswer))
}

/**
 * The session lines of `hosts/<host>.md`: the Needs verdict, every bot-protection finding with
 * its full evidence, the cookies and the spec. `pageOnly` marks a host that served only pages.
 */
export function sessionLines(entry: SessionRequirement, analysis: Analysis, context: AgentGuideContext, pageOnly: boolean, stems: HostStems): string[] {
  const tested = probedRequires(entry, analysis)
  const headers = neededHeaders(tested)
  const lines: string[] = []
  if (pageOnly)
    lines.push('- Serves pages only: no API calls to this host were captured.')
  lines.push(needsLine(entry, headers, context))
  // Probe measured that plain requests work: say so instead of contradicting the verdict.
  // `probed` is false whenever a probed call on the host failed, so this never claims too much.
  const answered = entry.probed && entry.requires !== 'browser'
  for (const finding of entry.botProtection) {
    lines.push(answered
      ? `- Bot protection seen: ${text(finding.vendor)} (${text(finding.evidence)}). Probe's plain requests were answered without it; if they start being challenged, use a real browser session (\`browserSession\` in \`@site-to-api/runtime\`) rather than reproducing it.`
      : `- Bot protection: ${text(finding.vendor)} (${text(finding.evidence)}). Do not try to reproduce it; let a real browser run it (\`browserSession\` in \`@site-to-api/runtime\`).`)
  }
  if (servedOnlyChallenges(entry.host, analysis))
    lines.push('- No real content: every response this host gave the capture was a bot challenge or block page, so its specs describe the interstitial, not the site. Capture again with a browser session the site lets through; probe results cannot show that plain HTTP works here.')
  const guarded = entry.botProtection.length === 0 || entry.requires !== 'browser'
    ? []
    : analysis.operations.filter(operation => operation.host === entry.host && operation.kind === 'api' && sendsBotProtectionHeaders(operation))
  if (guarded.length > 0)
    lines.push(`- Calls that send the bot-protection script's headers, so only a real browser can make them: ${guarded.map(operation => code(operation.operationId)).join(', ')}.`)
  // The host's verdict follows its tested calls; a call the script adds headers to is the
  // exception, named here rather than turning the whole host into "needs a browser" (0046).
  const browserOnly = browserOnlyCalls(entry, analysis.operations)
  if (browserOnly.length > 0)
    lines.push(`- Only a real browser can make ${plural(browserOnly.length, 'this call', 'these calls')}, although the host's other calls work with plain HTTP: ${browserOnly.map(code).join(', ')}. ${plural(browserOnly.length, 'It sends', 'They send')} headers a bot-protection script computes in the page; make ${plural(browserOnly.length, 'it', 'them')} through a real browser session (\`browserSession\` in \`@site-to-api/runtime\`), never by reproducing the headers.`)
  lines.push(...cookieLines(entry, tested))
  lines.push(`- Spec: ${code(`specs/${specFileName(entry.host, stems)}`)}.`)
  return lines
}

/** Evidence items shown per bot-protection vendor in `AGENT.md`; the host file has them all. */
const MAX_EVIDENCE = 3

/** Header and call names shown in a host's line in `AGENT.md`; the host file has them all. */
const MAX_NAMES = 3

/**
 * `Kasada (cookie KP_UIDz; request header x-kpsdk-ct; ... and 9 more)`. The evidence is the
 * `; `-joined list the classifier wrote; the cut is only for display, the host file keeps it whole.
 */
function shortFinding(finding: SessionRequirement['botProtection'][number]): string {
  const items = finding.evidence.split('; ')
  const shown = items.slice(0, MAX_EVIDENCE).map(text).join('; ')
  const more = items.length > MAX_EVIDENCE
    ? `; and ${items.length - MAX_EVIDENCE} more`
    : ''
  return `${text(finding.vendor)} (${shown}${more})`
}

/** The verdict of one host for its line in `AGENT.md`, without a trailing period. */
export function shortVerdict(entry: SessionRequirement | null, analysis: Analysis, context: AgentGuideContext): string {
  if (entry === null)
    return 'no session requirements recorded'
  const headers = neededHeaders(probedRequires(entry, analysis))
  const verdict = entry.requires === 'none' && headers.length > 0
    ? `plain HTTP; requests need ${plural(headers.length, 'header', 'headers')} ${headers.slice(0, MAX_NAMES).map(code).join(', ')}${headers.length > MAX_NAMES
      ? ` and ${headers.length - MAX_NAMES} more`
      : ''}`
    : SHORT_REQUIREMENT[entry.requires]
  const parts = [`${verdict} (${shortSource(entry, context.probe)})`]
  const browserOnly = browserOnlyCalls(entry, analysis.operations)
  if (browserOnly.length > 0) {
    parts.push(`except ${browserOnly.slice(0, MAX_NAMES).map(code).join(', ')}${browserOnly.length > MAX_NAMES
      ? ` and ${browserOnly.length - MAX_NAMES} more`
      : ''}, which only a real browser can make (bot-protection headers)`)
  }
  if (entry.botProtection.length > 0)
    parts.push(`bot protection: ${entry.botProtection.map(shortFinding).join(', ')}`)
  if (servedOnlyChallenges(entry.host, analysis))
    parts.push('no real content, only challenge pages')
  return parts.join('; ')
}
