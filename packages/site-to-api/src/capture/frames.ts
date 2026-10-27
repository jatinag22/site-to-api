/**
 * Which frames may report instrumentation events.
 *
 * The binding is exposed to every frame, including third-party and cross-origin iframes (ads,
 * embedded widgets, a hostile page's own iframes), and any of them could send forged requests,
 * actions or response bodies. Only frames that belong to the site being captured are listened to.
 *
 * Rule: the top frame is always accepted. Another frame is accepted when its origin equals the
 * top frame's origin, or when both are http(s) and their hosts share a registrable host
 * ({@link registrableHost}). `about:blank`, `about:srcdoc` and `blob:` frames take the origin of
 * the document that created them, approximated by walking up to the nearest parent with a real
 * URL. Everything else is ignored and counted in a capture warning.
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

/** Origin of a URL, or `null` for `about:` URLs and unparsable ones, which inherit their creator's. */
function originOf(url: string): string | null {
  if (url === '' || url.startsWith('about:'))
    return null
  try {
    return new URL(url).origin
  }
  catch {
    return null
  }
}

/** The part of a Playwright `Frame` that {@link effectiveOrigin} needs. */
export interface FrameLike {
  url: () => string
  parentFrame: () => FrameLike | null
}

/**
 * Origin of the document in a frame: its own URL's origin, or for `about:blank`/`about:srcdoc`
 * frames the origin of the nearest ancestor with a real URL. `null` (the string) when none has.
 */
export function effectiveOrigin(frame: FrameLike): string {
  let current: FrameLike | null = frame
  while (current !== null) {
    const origin = originOf(current.url())
    if (origin !== null)
      return origin
    current = current.parentFrame()
  }
  return 'null'
}

/** True when events from a frame with `frameOrigin` should be recorded for a top frame with `topOrigin`. */
export function isFrameInScope(frameOrigin: string, topOrigin: string): boolean {
  if (frameOrigin === topOrigin)
    return frameOrigin !== 'null'
  let frame: URL
  let top: URL
  try {
    frame = new URL(frameOrigin)
    top = new URL(topOrigin)
  }
  catch {
    return false
  }
  const web = /^https?:$/
  if (!web.test(frame.protocol) || !web.test(top.protocol))
    return false
  return registrableHost(frame.hostname) === registrableHost(top.hostname)
}
