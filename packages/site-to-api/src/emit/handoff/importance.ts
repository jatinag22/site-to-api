/**
 * What `AGENT.md` lists first (decision 0041): hosts of the site's own API before page hosts
 * before third parties, and flows that log in or set up a session before the rest. Deterministic:
 * every order ends in a comparison of names or of the original position.
 */
import type { Analysis, ComputedValue, Exchange, Flow, Operation, SessionRequirement } from '../../model'
import type { StepResolver } from '../steps'
import { registrableHost } from '../../hosts'

/** The three groups of hosts, in the order `AGENT.md` lists them. */
export type HostRole = 'first-party' | 'pages' | 'third-party'

export interface RankedHost {
  host: string
  role: HostRole
  /** Session verdict; `null` for a host with operations but no session entry. */
  session: SessionRequirement | null
  /** Observed (not code-only) API operations, the main sort key within a group. */
  apiOperations: number
}

/** `api.example.com:8443` → `example.com`; the port is not part of the site. */
function siteOf(host: string): string {
  return registrableHost(host.replace(/:\d+$/, ''))
}

/** `sec-fetch-dest` of a request, when the capture recorded it. */
function fetchDest(exchange: Pick<Exchange, 'request'>): string | undefined {
  return exchange.request.headers.find(header => header.name === 'sec-fetch-dest')?.value
}

/**
 * The hosts whose pages were only ever loaded into frames: ad and identity-sync networks render
 * their own pages inside iframes (Stack Overflow's `prebid.a-mo.net`, livecoinwatch's
 * `cdn.coinzilla.io`, Nike's `photos.pixlee.co` widget), and those are not the site. The browser
 * says which with `sec-fetch-dest`; a host with no page request carrying it (a capture without
 * the header) counts as browsed, and one browsed page outweighs any frames.
 */
function framedHosts(operations: readonly Operation[]): Set<string> {
  const dests = new Map<string, Set<string | undefined>>()
  for (const operation of operations) {
    if (operation.kind !== 'page' || operation.sourceOnly)
      continue
    const seen = dests.get(operation.host) ?? new Set()
    for (const exchange of operation.exchanges)
      seen.add(fetchDest(exchange))
    dests.set(operation.host, seen)
  }
  return new Set([...dests]
    .filter(([, seen]) => (seen.has('iframe') || seen.has('frame')) && !seen.has('document'))
    .map(([host]) => host))
}

/**
 * Every host the folder has a file for: those with a session verdict, page-only hosts, and hosts
 * that only have operations or channels. Sorted first-party API hosts → page hosts → third-party
 * hosts, then by observed API operations (most first), then by name.
 */
function hostOfUrl(url: string): string[] {
  try {
    const { host } = new URL(url)
    return host === ''
      ? []
      : [host]
  }
  catch {
    return []
  }
}

export function rankHosts(analysis: Analysis, pageHosts: readonly SessionRequirement[]): RankedHost[] {
  const sessions = new Map<string, SessionRequirement>()
  for (const entry of [
    ...analysis.flows.session,
    ...pageHosts,
  ])
    sessions.set(entry.host, entry)
  const pageOnly = new Set(pageHosts.map(entry => entry.host))
  const hosts = new Set<string>([
    ...sessions.keys(),
    ...analysis.operations.map(operation => operation.host),
    ...(analysis.channels ?? []).map(channel => channel.host),
  ])
  // The site is whatever served the pages the person browsed, never pages loaded into frames;
  // with no pages (an API-only capture), every host counts as the site's own (decision 0046).
  const framed = framedHosts(analysis.operations)
  const browsed = new Set(analysis.operations
    .filter(operation => operation.kind === 'page' && !operation.sourceOnly && !framed.has(operation.host))
    .map(operation => siteOf(operation.host)))
  // No page at all: the start URL still says which site the person meant (YouTube's navigations
  // all looked like calls, and a font host ranked first); only without one is every host the site's.
  const site = browsed.size > 0
    ? browsed
    : new Set((analysis.startUrls ?? []).flatMap(url => hostOfUrl(url)).map(siteOf))
  const ownHost = (host: string): boolean => site.size === 0 || site.has(siteOf(host))
  const roleOf = (host: string): HostRole => {
    // A host that served only pages is one of the site's page hosts when it is on the site's
    // domain or served a page the person browsed; a host whose pages were all framed (an ad
    // network's sync page) or that only answered a captcha widget is a third party.
    if (pageOnly.has(host)) {
      const served = analysis.operations.some(operation => operation.host === host && !operation.sourceOnly)
      return !served || ownHost(host)
        ? 'pages'
        : 'third-party'
    }
    return ownHost(host)
      ? 'first-party'
      : 'third-party'
  }
  const order: Record<HostRole, number> = { 'first-party': 0, 'pages': 1, 'third-party': 2 }
  return [...hosts]
    .map(host => ({
      host,
      role: roleOf(host),
      session: sessions.get(host) ?? null,
      apiOperations: analysis.operations.filter(operation => operation.host === host && operation.kind === 'api' && !operation.sourceOnly).length,
    }))
    .sort((a, b) => order[a.role] - order[b.role] || b.apiOperations - a.apiOperations || a.host.localeCompare(b.host))
}

/** Words that mark a flow, page or endpoint as logging in. */
const LOGIN_WORDS = /(?:^|[^a-z])(?:log[ _-]?in|log[ _-]?on|sign[ _-]?in|sign[ _-]?on|sign[ _-]?up|auth\w*|oauth|sso|session|otp|password|register)(?:[^a-z]|$)/i

/** Words that mark an endpoint as handing out something later requests send. */
const SETUP_WORDS = /(?:^|[^a-z])(?:token|csrf|captcha|consent)(?:[^a-z]|$)/i

/**
 * 0 for a flow with an API call that logs in or sets up a session (its path says so: `POST
 * /api/auth/login`), 1 for one whose name or trigger says so (the "Sign in" link that opens the
 * form), 2 for one with an API call that hands out a token or sets a cookie in a response
 * (`GET /api/live-token`), 3 for one whose steps feed
 * each other or that submits a form, 4 for the rest. Page loads and bot-protection steps set
 * cookies on every flow, so only API steps count for tier 2.
 */
function flowTier(flow: Flow, resolver: StepResolver, cookieSetters: ReadonlySet<string>): number {
  const api = flow.steps.filter(step => step.kind === 'api')
  const paths = api.map(step => resolver.operation(step)?.path ?? '')
  if (paths.some(path => LOGIN_WORDS.test(path)))
    return 0
  if ([flow.name, flow.trigger.label].some(value => LOGIN_WORDS.test(value)))
    return 1
  if (paths.some(path => SETUP_WORDS.test(path)) || api.some(step => cookieSetters.has(step.operationId)))
    return 2
  const linked = flow.steps.some(step => Object.values(step.inputs).some(origin => origin.kind === 'step' || origin.kind === 'html'))
  return linked || flow.trigger.kind === 'submit'
    ? 3
    : 4
}

/** Flows, session setup first; then by sessions that confirmed them; then in `flows.json` order. */
export function rankFlows(analysis: Analysis, resolver: StepResolver): Flow[] {
  const cookieSetters = new Set(analysis.flows.session.flatMap(entry => entry.cookies.flatMap(cookie => cookie.setBy === null || cookie.source !== 'response'
    ? []
    : [cookie.setBy])))
  return analysis.flows.flows
    .map((flow, index) => ({
      flow,
      index,
      tier: flowTier(flow, resolver, cookieSetters),
    }))
    .sort((a, b) => a.tier - b.tier || b.flow.seenInSessions - a.flow.seenInSessions || a.index - b.index)
    .map(({ flow }) => flow)
}

/** Endpoints that report on the page rather than serve it: event, log, metric and tracking sinks. */
const TELEMETRY_WORDS = /(?:^|[^a-z])(?:events?|telemetry|analytics|metrics?|logs?|logging|collect(?:or)?|track(?:ing|er)?|beacons?|pixel|rum|ping|stats|heartbeat)(?:[^a-z]|$)/i

/** Request fields that carry a credential or a code a server checks. */
const CREDENTIAL_INPUT = /(?:^|[^a-z])(?:authorization|token|password|passwd|otp|totp|mfa|signature|sig|nonce|csrf|xsrf|captcha|secret)(?:[^a-z]|$)/i

/**
 * 0 for a value a login, token or session call needs (its path, name or the input says so:
 * `query.totp` of `GET /api/token`, `body./password` of `POST /login`), 2 for a value sent to a
 * telemetry or analytics sink (`body./events/0/sequence_id` of `POST /v3/events`), 1 for the rest:
 * the site's own API. A wrapper must port the first kind, rarely the last.
 */
export function computedTier(value: ComputedValue, analysis: Analysis, resolver: StepResolver): number {
  const host = resolver.computedHost(value)
  const operation = analysis.operations.find(candidate => candidate.operationId === value.operationId && (host === null || candidate.host === host))
  const path = operation?.path ?? ''
  const words = value.input.replace(/([a-z\d])([A-Z])/g, '$1 $2')
  if ([path, value.operationId].some(text => LOGIN_WORDS.test(text) || SETUP_WORDS.test(text)) || CREDENTIAL_INPUT.test(words))
    return 0
  return TELEMETRY_WORDS.test(path)
    ? 2
    : 1
}
