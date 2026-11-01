/**
 * Page loads that failed outright (status -1/0 with a network error, or a 403 refusal), and a
 * first page that answered 404. Shared by `capture`, which warns right away, and
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

/** Errors that mean nothing answered at that address: the site is not running or the URL is wrong. */
const NOT_LISTENING = /ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE|ERR_ADDRESS_INVALID/

/** Chrome refuses some ports outright (1, 22, 6000, ...), whatever listens there. */
const UNSAFE_PORT = /ERR_UNSAFE_PORT/

/** Errors and statuses that look like a site refusing automated browsers. */
const BLOCKED = /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_HTTP2_PROTOCOL_ERROR|ERR_BLOCKED/

type FailureKind = 'dns' | 'not-listening' | 'unsafe-port' | 'blocked' | 'other'

function kindOf(navigation: Navigation): FailureKind {
  if (isNameNotResolved(navigation))
    return 'dns'
  const failure = navigation.failure ?? ''
  if (NOT_LISTENING.test(failure))
    return 'not-listening'
  if (UNSAFE_PORT.test(failure))
    return 'unsafe-port'
  if (navigation.status === 403 || BLOCKED.test(failure))
    return 'blocked'
  return 'other'
}

/** A page load that did not get the page: a network error, or a 403 refusal. */
function failedLoad(navigation: Navigation): boolean {
  return navigation.status <= 0 || navigation.status === 403
}

const ADVICE: Record<FailureKind, (hosts: string) => string> = {
  'dns': hosts => `${hosts} could not be resolved (blocked by DNS, for example an ad or tracker blocklist, or the machine is offline). Check the network and DNS settings, then capture again.`,
  'not-listening': hosts => `nothing is listening at ${hosts}. Start the site or check the URL, then capture again.`,
  'unsafe-port': hosts => `the browser refuses to connect to ${hosts}: that port is on its list of unsafe ports. Start the site on another port (for example 3000 or 8080) or check the URL, then capture again.`,
  'blocked': () => 'the site probably blocks automated browsers, so this capture has little or none of its traffic. Capture with a visible browser (--channel chrome, without --headless); if it still fails, the site does not allow automated access and its official API or data feed is the way in.',
  'other': hosts => `the browser could not load ${hosts}. Check the URL and the network, then capture again.`,
}

/**
 * A warning when most or all page loads failed, naming the errors, or when the first page
 * answered 404; null otherwise. Each kind of failure gets its own advice: a host that does not
 * resolve (DNS), nothing listening at the address (the site is not running or the URL is wrong),
 * a refusal or timeout (decision 0008: use a visible real browser, never get around a block), or
 * anything else. The bot-protection advice is only for the refusals.
 */
export function failedNavigationsWarning(navigations: readonly Navigation[]): string | null {
  const notFound = navigations[0]?.status === 404
    ? `The first page answered 404 Not Found (${hostList(navigations.slice(0, 1))}): check the URL.`
    : null
  const failed = navigations.filter(failedLoad)
  if (failed.length === 0 || failed.length / navigations.length < MOSTLY)
    return notFound
  const errors = [
    ...new Set(failed.map(navigation => navigation.failure ?? (navigation.status === 403
      ? 'status 403'
      : 'no response'))),
  ].sort().join(', ')
  const share = failed.length === navigations.length
    ? `Every page load failed (${errors}; ${failed.length} of ${navigations.length})`
    : `${failed.length} of ${navigations.length} page loads failed (${errors})`
  const kinds: FailureKind[] = [
    'blocked',
    'not-listening',
    'unsafe-port',
    'dns',
    'other',
  ]
  const advice = kinds.flatMap((kind) => {
    const these = failed.filter(navigation => kindOf(navigation) === kind)
    return these.length === 0
      ? []
      : [
          ADVICE[kind](hostList(these)),
        ]
  })
  const [first, ...rest] = advice
  const more = rest.length === 0
    ? ''
    : ` Some loads failed for another reason: ${rest.join(' ')}`
  return `${notFound === null
    ? ''
    : `${notFound} `}${share}: ${first ?? ''}${more}`
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
