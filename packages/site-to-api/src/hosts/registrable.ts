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
  'storage.googleapis.com',
  'azurestaticapps.net',
  'ngrok-free.app',
  'supabase.co',
]

/**
 * AWS hosts tenants under service and region labels (`bucket.s3.us-east-1.amazonaws.com`,
 * `abc123.execute-api.eu-west-1.amazonaws.com`, `ec2-1-2-3-4.compute-1.amazonaws.com`,
 * `fn.lambda-url.us-east-1.on.aws`): those labels belong to the suffix, so tenants stay apart.
 */
const AWS_ROOTS: readonly string[] = ['amazonaws.com', 'on.aws']
const AWS_LABEL = /^(?:s3|s3-website|s3-accesspoint|s3-control|dualstack|execute-api|lambda-url|elb|compute(?:-\d+)?|[a-z]{2}(?:-gov)?-[a-z]+-\d+)$/

/** Labels of the AWS suffix of a host (`s3.us-east-1.amazonaws.com` is 4), or null. */
function awsSuffixLength(host: string, labels: readonly string[]): number | null {
  const root = AWS_ROOTS.find(suffix => host === suffix || host.endsWith(`.${suffix}`))
  if (root === undefined)
    return null
  let length = root.split('.').length
  while (length < labels.length - 1 && AWS_LABEL.test(labels.at(-length - 1) ?? ''))
    length++
  return length
}

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
  const aws = awsSuffixLength(host, labels)
  let keep = 2
  if (aws !== null)
    keep = aws + 1
  else if (shared !== undefined)
    keep = shared.split('.').length + 1
  else if (labels.length >= 3 && (labels.at(-1) ?? '').length === 2 && COUNTRY_SECOND_LEVEL.has(labels.at(-2) ?? ''))
    keep = 3
  return labels.slice(-keep).join('.')
}
