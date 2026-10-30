/**
 * Which host names belong to one site. Used by capture (frame scope, the sourcemap guard) and by
 * analysis (same-site HTML origins), so it lives outside both: analysis must not load Playwright.
 */

/**
 * Suffixes under which unrelated owners get their own subdomain. Two tenants of the same host
 * are different sites, so for these the registrable host keeps one more label. Not the full
 * Public Suffix List: just the hosts most likely to appear as a captured site.
 */
const SHARED_SUFFIXES = [
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'appspot.com',
  'herokuapp.com',
  'azurewebsites.net',
  'cloudfront.net',
  'blogspot.com',
  'onrender.com',
  'fly.dev',
  'a.run.app',
  'run.app',
  'cloudfunctions.net',
  'amazonaws.com',
  'azurestaticapps.net',
  'ngrok-free.app',
  'supabase.co',
]

/** Second-level labels that act as public suffixes under country TLDs (`co.uk`, `com.au`). */
const COUNTRY_SECOND_LEVEL = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gob',
  'go',
  'gov',
  'ltd',
  'mil',
  'ne',
  'net',
  'nic',
  'or',
  'org',
  'plc',
])

function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host)
}

/**
 * The registrable part of a host name, used to treat `www.example.com` and `api.example.com` as
 * one site: the last two labels, three under country second-level suffixes such as `co.uk`, and
 * one more under {@link SHARED_SUFFIXES}. IP addresses and single-label hosts are their own
 * registrable host. This approximates the Public Suffix List without shipping it; an unknown
 * shared-hosting suffix makes two of its tenants look like one site, which only means their
 * iframes' events are kept.
 */
export function registrableHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (isIpLiteral(host))
    return host
  const labels = host.split('.')
  const shared = SHARED_SUFFIXES.find(suffix => host === suffix || host.endsWith(`.${suffix}`))
  let keep = 2
  if (shared !== undefined)
    keep = shared.split('.').length + 1
  else if (labels.length >= 3 && (labels.at(-1) ?? '').length === 2 && COUNTRY_SECOND_LEVEL.has(labels.at(-2) ?? ''))
    keep = 3
  return labels.slice(-keep).join('.')
}
