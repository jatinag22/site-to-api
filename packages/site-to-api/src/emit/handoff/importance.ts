/**
 * What `AGENT.md` lists first (decision 0041): hosts of the site's own API before page hosts
 * before third parties, and flows that log in or set up a session before the rest. Deterministic:
 * every order ends in a comparison of names or of the original position.
 */
import type { Analysis, Flow, SessionRequirement } from '../../model'
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

/**
 * Every host the folder has a file for: those with a session verdict, page-only hosts, and hosts
 * that only have operations or channels. Sorted first-party API hosts → page hosts → third-party
 * hosts, then by observed API operations (most first), then by name.
 */
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
  // The site is whatever served the pages the person browsed; with no pages (an API-only
  // capture), every host counts as the site's own.
  const site = new Set(analysis.operations.filter(operation => operation.kind === 'page' && !operation.sourceOnly).map(operation => siteOf(operation.host)))
  const roleOf = (host: string): HostRole => {
    if (pageOnly.has(host))
      return 'pages'
    return site.size === 0 || site.has(siteOf(host))
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
