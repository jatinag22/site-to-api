/**
 * Page loads that failed outright (status -1/0 with a network error, as in a HAR from a site that
 * blocks automated browsers at the connection). Shared by `capture`, which warns right away, and
 * `build`, which states it in AGENT.md.
 */

/** One top-level document request: its status and, when it failed, the browser's error. */
export interface Navigation {
  status: number
  failure: string | null
  /** Host name of the page, when the HAR entry had a readable URL. */
  host?: string
}

/** Chrome's error when a host name does not resolve: a DNS block (Pi-hole, NextDNS) or no network. */
const NAME_NOT_RESOLVED = 'ERR_NAME_NOT_RESOLVED'

function isNameNotResolved(navigation: Navigation): boolean {
  return navigation.failure?.includes(NAME_NOT_RESOLVED) === true
}

/** `www.example.com, cdn.example.com` (sorted), or `the host` when no URL was recorded. */
function hostList(navigations: readonly Navigation[]): string {
  const hosts = [
    ...new Set(navigations.flatMap(navigation => navigation.host === undefined
      ? []
      : [navigation.host])),
  ].sort()
  return hosts.length === 0
    ? 'the host'
    : hosts.join(', ')
}

/** Share of failed page loads from which the capture is reported as blocked. */
const MOSTLY = 0.5

/**
 * A warning when most or all page loads failed, naming the errors; null otherwise. The advice
 * follows decision 0008: use a visible real browser, never try to get around the block. Loads
 * that failed because a host name did not resolve say so instead: that is a DNS block or no
 * network on this machine, not the site refusing automated browsers.
 */
export function failedNavigationsWarning(navigations: readonly Navigation[]): string | null {
  const failed = navigations.filter(navigation => navigation.status <= 0)
  if (failed.length === 0 || failed.length / navigations.length < MOSTLY)
    return null
  const errors = [
    ...new Set(failed.map(navigation => navigation.failure ?? 'no response')),
  ].sort().join(', ')
  const share = failed.length === navigations.length
    ? `Every page load failed (${errors}; ${failed.length} of ${navigations.length})`
    : `${failed.length} of ${navigations.length} page loads failed (${errors})`
  const unresolved = failed.filter(isNameNotResolved)
  const dns = `${hostList(unresolved)} could not be resolved (blocked by DNS, for example an ad or tracker blocklist, or the machine is offline). Check the network and DNS settings, then capture again.`
  if (unresolved.length === failed.length)
    return `${share}: ${dns}`
  const blocked = `${share}: the site probably blocks automated browsers, so this capture has little or none of its traffic. Capture with a visible browser (--channel chrome, without --headless); if it still fails, the site does not allow automated access and its official API or data feed is the way in.`
  return unresolved.length === 0
    ? blocked
    : `${blocked} Some loads failed for another reason: ${dns}`
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string')
    return undefined
  try {
    return new URL(url).host || undefined
  }
  catch {
    return undefined
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/**
 * The top-level page loads in a HAR's entries: document requests of each page's main frame,
 * which is the frame of that page's first document request. Iframes are not page loads, and a
 * load the browser aborted itself (`net::ERR_ABORTED`, a navigation replaced by another) did not
 * fail, so neither counts.
 */
export function harNavigations(entries: readonly unknown[]): Navigation[] {
  const mainFrame = new Map<string, unknown>()
  const result: Navigation[] = []
  for (const entry of entries) {
    if (field(entry, '_resourceType') !== 'document')
      continue
    const response = field(entry, 'response')
    const status = field(response, 'status')
    if (typeof status !== 'number')
      continue
    const page = String(field(entry, 'pageref') ?? '')
    const frame = field(entry, '_frameref')
    if (!mainFrame.has(page))
      mainFrame.set(page, frame)
    if (mainFrame.get(page) !== frame)
      continue
    const failureText = field(response, '_failureText')
    const failure = typeof failureText === 'string'
      ? failureText
      : null
    if (failure?.includes('ERR_ABORTED'))
      continue
    const host = hostOf(field(field(entry, 'request'), 'url'))
    result.push(host === undefined
      ? { status, failure }
      : { status, failure, host })
  }
  return result
}
