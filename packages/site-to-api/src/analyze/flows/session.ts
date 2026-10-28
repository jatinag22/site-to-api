/** Per-host session requirements: which cookies the APIs need, who sets them, bot protection. */
import type { BotProtectionFinding, Exchange, Operation, SessionRequirement, ValueTrace } from '../../model'
import { cookieNeedsBrowser } from '../../model'
import { botProtectionVendor } from '../correlate'

/**
 * Analytics cookies travel with every request but no API depends on them; counting them would
 * make every site look like it needs a browser.
 */
const ANALYTICS_COOKIE = /^(?:_ga|_gid|_gcl_|_fbp|_fbc|_hj|_clck|_clsk|_uetsid|_uetvid|ajs_|mp_|_ttp|_pin_unauth)/

type TraceOriginKind = ValueTrace['origin']['kind']

/** Origins a wrapper can reproduce: a value from a response (or HTML), a transform of one, or typed input. */
const DERIVABLE_ORIGINS: ReadonlySet<TraceOriginKind> = new Set(['response', 'transform', 'user-input'])

function cookieKey(host: string, name: string): string {
  return `${host}\u0000${name}`
}

/**
 * Traced origin kinds of every cookie sent, keyed by host + name: two hosts may each have a
 * cookie with the same name and different origins.
 */
function cookieOrigins(traces: readonly ValueTrace[], exchanges: readonly Exchange[]): Map<string, Set<TraceOriginKind>> {
  const hostOf = new Map(exchanges.map(exchange => [exchange.id, exchange.request.host]))
  const result = new Map<string, Set<TraceOriginKind>>()
  for (const trace of traces) {
    const host = hostOf.get(trace.exchangeId)
    if (trace.location.in !== 'cookie' || host === undefined)
      continue
    const key = cookieKey(host, trace.location.name)
    const kinds = result.get(key) ?? new Set()
    kinds.add(trace.origin.kind)
    result.set(key, kinds)
  }
  return result
}

/**
 * Source of a cookie no captured response set (decision 0020, refined):
 * - `browser`: bot protection, or an opaque value the tracer found no origin for (`browser` or
 *   `unknown` trace); only a real browser produces it.
 * - `script`: a page script set it from a value that traces to a response, HTML, a transform or
 *   typed input, so the wrapper can derive it and set it itself.
 * - `unknown`: present in the browser profile with no origin seen. A cookie identical in every
 *   session (traced as `constant`, e.g. a login `sid` from a reused profile) or too short to
 *   trace. It does not force a browser on its own; a probe can tell whether it is needed.
 */
function scriptCookieSource(name: string, origins: ReadonlySet<TraceOriginKind> | undefined): SessionRequirement['cookies'][number]['source'] {
  if (botProtectionVendor(name) !== null || origins?.has('browser') === true || origins?.has('unknown') === true)
    return 'browser'
  if (origins !== undefined && [...origins].some(kind => DERIVABLE_ORIGINS.has(kind)))
    return 'script'
  return 'unknown'
}

/** Derives what a client needs per host before calling its APIs. Never includes cookie values. */
export function sessionRequirements(input: {
  /** All exchanges in capture order (sessions sorted by id). */
  exchanges: readonly Exchange[]
  operations: readonly Operation[]
  traces: readonly ValueTrace[]
  botProtection: readonly BotProtectionFinding[]
  operationOf: (exchange: Exchange) => Operation | undefined
}): SessionRequirement[] {
  const apiOperations = input.operations.filter(operation => operation.kind === 'api' && !operation.sourceOnly)
  const hosts = [
    ...new Set([
      ...apiOperations.map(operation => operation.host),
      ...input.botProtection.map(finding => finding.host),
    ]),
  ].sort()
  const originsByCookie = cookieOrigins(input.traces, input.exchanges)

  return hosts.map((host): SessionRequirement => {
    const operations = apiOperations.filter(operation => operation.host === host)
    const names = [
      ...new Set(operations.flatMap(operation => operation.cookies.map(cookie => cookie.name))),
    ]
      .filter(name => !ANALYTICS_COOKIE.test(name))
      .sort()
    const cookies = names.map((name): SessionRequirement['cookies'][number] => {
      const producer = input.exchanges.find(exchange => exchange.response.setCookies.some(cookie => cookie.name === name))
      if (producer)
        return { name, setBy: input.operationOf(producer)?.operationId ?? null, source: 'response' }
      return {
        name,
        setBy: null,
        source: scriptCookieSource(name, originsByCookie.get(cookieKey(host, name))),
      }
    })
    const botProtection = [
      ...new Map(input.botProtection
        .filter(finding => finding.host === host)
        .map(finding => [
          `${finding.vendor}\u0000${finding.evidence}`,
          { vendor: finding.vendor, evidence: finding.evidence },
        ])).values(),
    ]
      .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.evidence.localeCompare(b.evidence))
    const needsToken = operations.some(operation => operation.headers.some(header => header.name.toLowerCase() === 'authorization'))
    let requires: SessionRequirement['requires'] = 'none'
    if (botProtection.length > 0 || cookies.some(cookieNeedsBrowser))
      requires = 'browser'
    else if (needsToken)
      requires = 'token'
    else if (cookies.length > 0)
      requires = 'cookies'
    return {
      host,
      requires,
      cookies,
      botProtection,
      probed: false,
    }
  })
}
