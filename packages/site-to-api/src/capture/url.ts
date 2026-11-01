/** The capture URL as typed by a person: a full URL, or a host with an optional port and path. */
import { SiteToApiError } from '../errors'

/** Hosts that are this machine, served over plain HTTP in development. */
const LOCAL_HOST = /^(?:localhost|[^/]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i

const EXAMPLE = 'for example https://example.com or localhost:3000'

/**
 * The URL to open first. A bare host gets a scheme: `http://` for this machine (`localhost:3000`),
 * `https://` otherwise (`example.com/shop`). Throws {@link SiteToApiError} with an example for
 * anything that is not an http(s) URL of a plausible host.
 */
export function normalizeCaptureUrl(input: string): string {
  const typed = input.trim()
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(typed)
  const withScheme = hasScheme
    ? typed
    : `${LOCAL_HOST.test(typed)
      ? 'http'
      : 'https'}://${typed}`
  let url: URL
  try {
    url = new URL(withScheme)
  }
  catch {
    throw new SiteToApiError(`"${input}" is not a URL. Pass the page to open first, ${EXAMPLE}.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new SiteToApiError(`"${input}" is a ${url.protocol} URL; capture opens http and https pages only, ${EXAMPLE}.`)
  // A host needs a dot, a port or to be this machine: "shop" alone is far more often a typo
  // (a missing ".com") than an intranet name.
  const plausible = url.hostname.includes('.') || url.hostname.startsWith('[') || url.port !== '' || url.hostname === 'localhost'
  if (!plausible)
    throw new SiteToApiError(`"${input}" does not name a host. Pass the page to open first, ${EXAMPLE}.`)
  return url.href
}
