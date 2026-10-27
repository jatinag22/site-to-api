/**
 * Host globs from the `hosts.include` / `hosts.exclude` config. `*` matches any run of characters,
 * dots included, so `*.example.com` matches `api.example.com` and `a.b.example.com` but not
 * `example.com` itself; list both when both are wanted. Matching ignores case, and a pattern
 * without a port also matches the same host on any port.
 */

function toRegExp(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

/** Returns a predicate that is true when a host matches any of the patterns. */
export function compileHostGlobs(patterns: string[]): (host: string) => boolean {
  const compiled = patterns.map(pattern => ({
    regex: toRegExp(pattern),
    hasPort: /:\d+$/.test(pattern),
  }))
  return (host) => {
    const lower = host.toLowerCase()
    const hostname = lower.replace(/:\d+$/, '')
    return compiled.some(({ regex, hasPort }) => regex.test(hasPort ? lower : hostname))
  }
}
