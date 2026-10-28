/** Checks on the `hosts.include` / `hosts.exclude` filter that `build` applies. */
import type { ResolvedConfig } from '../config/schema'
import type { Exchange } from '../model'
import { compileHostGlobs } from '../analyze/classify'

/**
 * Host patterns that match no captured host. A typo in `--include` otherwise silently leaves only
 * the bot-protection steps (which are kept on any host) and endpoints found in code.
 */
export function unmatchedHostPatterns(exchanges: Exchange[], hosts: ResolvedConfig['hosts']): string[] {
  const captured = [
    ...new Set(exchanges.map(exchange => exchange.request.host)),
  ].sort()
  const shown = captured.length > 8
    ? `${captured.slice(0, 8).join(', ')} and ${captured.length - 8} more`
    : captured.join(', ')
  return (['include', 'exclude'] as const).flatMap(list => hosts[list]
    .filter(pattern => !captured.some(compileHostGlobs([pattern])))
    .map(pattern => `hosts.${list} pattern "${pattern}" matches no captured host (captured: ${shown || 'none'}). Check it for a typo; host patterns are globs such as *.example.com, and a pattern with a port only matches that port.`))
}

/**
 * Endpoints found in code are only worth documenting on hosts the person asked for: a
 * `--include` that names another host must not bring back the real host's routes.
 */
export function inHostFilter(hosts: ResolvedConfig['hosts']): (host: string) => boolean {
  const included = compileHostGlobs(hosts.include)
  const excluded = compileHostGlobs(hosts.exclude)
  return host => !excluded(host) && (hosts.include.length === 0 || included(host))
}
