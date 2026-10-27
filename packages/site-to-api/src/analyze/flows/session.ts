/** Per-host session requirements: which cookies the APIs need, who sets them, bot protection. */
import type { BotProtectionFinding, Exchange, Operation, SessionRequirement, ValueTrace } from '../../model'
import { cookieNeedsBrowser } from '../../model'
import { botProtectionVendor } from '../correlate'

/**
 * Analytics cookies travel with every request but no API depends on them; counting them would
 * make every site look like it needs a browser.
 */
const ANALYTICS_COOKIE = /^(?:_ga|_gid|_gcl_|_fbp|_fbc|_hj|_clck|_clsk|_uetsid|_uetvid|ajs_|mp_|_ttp|_pin_unauth)/

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
  // Cookies whose value a wrapper cannot derive: set by a page script with no traceable origin.
  const opaqueCookies = new Set(input.traces.flatMap(trace =>
    trace.location.in === 'cookie' && (trace.origin.kind === 'browser' || trace.origin.kind === 'unknown')
      ? [trace.location.name]
      : []))

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
      // No response set it, so a script in the page did (document.cookie), or a reused browser
      // profile already had it. A wrapper can set `store=pine-hill` itself, but not an opaque
      // value or a bot-protection token.
      return {
        name,
        setBy: null,
        source: opaqueCookies.has(name) || botProtectionVendor(name) !== null
          ? 'browser'
          : 'script',
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
