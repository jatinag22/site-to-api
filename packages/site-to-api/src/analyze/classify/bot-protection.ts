/**
 * Bot-protection signatures. Detection only labels traffic so flows can mark it browser-only and
 * AGENT.md can name the vendor (decision 0008); nothing here helps to reproduce or bypass it.
 *
 * To add a vendor, append a {@link BotProtectionSignature}. `endpoints`, `bodies` and
 * `challengeHeaders` mark the exchange itself as bot-protection traffic. `cookies`,
 * `requestHeaders` and `responseHeaders` are evidence only: the site's real API calls carry them
 * too and must stay `api`.
 */
import type { Exchange, Operation } from '../../model'
import { hostMatchesDomain } from './noise-hosts'

interface BotProtectionSignature {
  vendor: string
  /**
   * Vendor hosts (domain suffix) and/or path patterns; every given part must match. A path comes
   * with the label evidence shows instead of the captured path, whose segments can hold challenge
   * tokens (`$1` is the pattern's first group).
   */
  endpoints: Array<{ domain?: string } | { domain?: string, path: RegExp, label: string }>
  /** Request body contents that only sensor or challenge submissions carry. */
  bodies: RegExp[]
  /** Response headers that mark a challenge response. */
  challengeHeaders: Array<{ name: string, value: RegExp }>
  /** Cookie names the vendor sets. */
  cookies: RegExp[]
  /** Request header names the vendor's script adds to protected calls. */
  requestHeaders: RegExp[]
  /** Response header names the vendor's edge adds. */
  responseHeaders: RegExp[]
}

const AKAMAI = 'Akamai'

const BOT_PROTECTION_SIGNATURES: readonly BotProtectionSignature[] = [
  {
    vendor: AKAMAI,
    endpoints: [
      { path: /^\/akam\/\d+\//, label: '/akam/<n>/…' },
    ],
    bodies: [/sensor_data/],
    challengeHeaders: [],
    cookies: [
      /^_abck$/,
      /^bm_sz$/,
      /^ak_bmsc$/,
      /^bm_sv$/,
      /^bm_mi$/,
      /^bm_so$/,
      /^bm_s$/,
    ],
    requestHeaders: [],
    responseHeaders: [],
  },
  {
    vendor: 'Cloudflare Turnstile',
    endpoints: [
      { domain: 'challenges.cloudflare.com' },
    ],
    bodies: [],
    challengeHeaders: [],
    cookies: [],
    requestHeaders: [],
    responseHeaders: [],
  },
  {
    vendor: 'Cloudflare',
    endpoints: [
      { path: /^\/cdn-cgi\/challenge-platform\//, label: '/cdn-cgi/challenge-platform/…' },
    ],
    // The managed challenge re-posts the page with a form whose field names are all hex digests.
    bodies: [/\n(?:[0-9a-f]{32,128}(?:&|$))+$/],
    challengeHeaders: [
      { name: 'cf-mitigated', value: /challenge/i },
    ],
    cookies: [/^cf_clearance$/, /^__cf_bm$/, /^cf_chl_/],
    requestHeaders: [],
    responseHeaders: [],
  },
  {
    vendor: 'PerimeterX',
    endpoints: [
      { domain: 'perimeterx.net' },
      { domain: 'px-cloud.net' },
      { domain: 'px-cdn.net' },
      { domain: 'px-client.net' },
      { domain: 'pxchk.net' },
      { path: /\/api\/v2\/collector/, label: '…/api/v2/collector' },
    ],
    bodies: [],
    challengeHeaders: [],
    cookies: [/^_px/, /^pxcts$/],
    requestHeaders: [/^x-px-/],
    responseHeaders: [],
  },
  {
    vendor: 'DataDome',
    endpoints: [
      { domain: 'datadome.co' },
      { domain: 'captcha-delivery.com' },
    ],
    bodies: [],
    challengeHeaders: [],
    cookies: [/^datadome$/],
    requestHeaders: [],
    responseHeaders: [/^x-datadome/, /^x-dd-b$/],
  },
  {
    vendor: 'Imperva',
    endpoints: [
      { path: /\/_Incapsula_Resource/, label: '/_Incapsula_Resource' },
    ],
    bodies: [],
    challengeHeaders: [],
    cookies: [
      /^incap_ses_/,
      /^visid_incap_/,
      /^nlbi_/,
      /^reese84$/,
      /^___utmvc$/,
    ],
    requestHeaders: [],
    responseHeaders: [/^x-iinfo$/],
  },
  {
    vendor: 'Kasada',
    // `/<uuid>/<uuid>/` then the script (`p.js`, `ips.js`), the fingerprint page (`fp`), the
    // sensor post (`tl`) and the proof-of-work config fetch (`mfc`). The `x-kpsdk-*` headers also
    // ride on the protected API calls, so they are evidence only.
    endpoints: [
      { path: /^\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(fp|tl|mfc|p\.js|ips\.js)$/i, label: '/<uuid>/<uuid>/$1' },
    ],
    bodies: [],
    challengeHeaders: [],
    cookies: [/^KP_UIDz/],
    requestHeaders: [/^x-kpsdk-/],
    responseHeaders: [/^x-kpsdk-/],
  },
  {
    // AWS WAF Bot Control: the challenge script and its `inputs` / `verify` / `mp_verify` calls go
    // to a vendor host (`<id>.<region>.token.awswaf.com`, `*.captcha.awswaf.com`,
    // `*.edge.sdk.awswaf.com`); a challenged request gets `x-amzn-waf-action: challenge|captcha`.
    vendor: 'AWS WAF',
    endpoints: [
      { domain: 'awswaf.com' },
    ],
    bodies: [],
    challengeHeaders: [
      { name: 'x-amzn-waf-action', value: /^(?:challenge|captcha)$/i },
    ],
    cookies: [/^aws-waf-token$/],
    requestHeaders: [/^x-aws-waf-token$/],
    responseHeaders: [],
  },
  {
    vendor: 'reCAPTCHA',
    endpoints: [
      { domain: 'recaptcha.net' },
      { domain: 'www.google.com', path: /^\/recaptcha\//, label: '/recaptcha/…' },
      { domain: 'www.gstatic.com', path: /^\/recaptcha\//, label: '/recaptcha/…' },
    ],
    bodies: [],
    challengeHeaders: [],
    cookies: [],
    requestHeaders: [],
    responseHeaders: [],
  },
  {
    vendor: 'hCaptcha',
    endpoints: [
      { domain: 'hcaptcha.com' },
    ],
    bodies: [],
    challengeHeaders: [],
    cookies: [],
    requestHeaders: [],
    responseHeaders: [],
  },
]

export interface BotEvidence {
  vendor: string
  evidence: string
  /** True when the exchange itself is bot-protection traffic, false when it only carries traces. */
  isTraffic: boolean
  /** True when the match was on a vendor-run host, so the protected site is the page's host. */
  thirdParty: boolean
}

function bodyText(exchange: Exchange): string {
  const body = exchange.request.body
  if (!body)
    return ''
  const formNames = body.form?.map(field => field.name).join('&') ?? ''
  return `${body.text ?? ''}\n${formNames}`
}

/**
 * Akamai Bot Manager posts sensor data to a first-party path made of random mixed-case segments,
 * e.g. `/Xb4Ks/Ld0/qP/nHvO2kq`. Only treated as a signal on hosts that also set Akamai cookies,
 * which keeps ordinary paths with odd segment names out.
 */
export function looksLikeRandomSensorPath(path: string): boolean {
  const segments = path.split('/').filter(segment => segment !== '')
  if (segments.length < 3)
    return false
  if (!segments.every(segment => /^[\w-]{2,}$/.test(segment)))
    return false
  if (segments.some(segment => /^[a-z]{4,}$/.test(segment)))
    return false
  const mixed = segments.filter(segment => /[a-z]/.test(segment) && /[A-Z0-9]/.test(segment)).length
  return mixed * 2 >= segments.length
}

type Found = Omit<BotEvidence, 'vendor'>

/** Matches that make the exchange itself bot-protection traffic. */
function trafficEvidence(signature: BotProtectionSignature, exchange: Exchange, body: string): Found[] {
  const { request, response } = exchange
  const found: Found[] = []
  for (const endpoint of signature.endpoints) {
    if (endpoint.domain !== undefined && !hostMatchesDomain(request.host, endpoint.domain))
      continue
    let label = ''
    if ('path' in endpoint) {
      const match = endpoint.path.exec(request.path)
      if (!match)
        continue
      label = endpoint.label.replace('$1', match[1] ?? '')
    }
    found.push({ evidence: `request to ${request.host}${label}`, isTraffic: true, thirdParty: endpoint.domain !== undefined })
  }
  for (const pattern of signature.bodies.filter(pattern => pattern.test(body)))
    found.push({ evidence: `request body matches ${pattern.source}`, isTraffic: true, thirdParty: false })
  for (const challenge of signature.challengeHeaders) {
    if (response.headers.some(header => header.name === challenge.name && challenge.value.test(header.value)))
      found.push({ evidence: `response header ${challenge.name}`, isTraffic: true, thirdParty: false })
  }
  return found
}

/** Traces the vendor leaves on ordinary calls: cookies and headers. */
function traceEvidence(signature: BotProtectionSignature, exchange: Exchange): Found[] {
  const { request, response } = exchange
  const trace = (evidence: string): Found => ({ evidence, isTraffic: false, thirdParty: false })
  const cookieNames = new Set([
    ...request.cookies,
    ...response.setCookies,
  ].map(cookie => cookie.name))
  return [
    ...[...cookieNames].filter(name => signature.cookies.some(pattern => pattern.test(name))).map(name => trace(`cookie ${name}`)),
    ...request.headers.filter(header => signature.requestHeaders.some(pattern => pattern.test(header.name))).map(header => trace(`request header ${header.name}`)),
    ...response.headers.filter(header => signature.responseHeaders.some(pattern => pattern.test(header.name))).map(header => trace(`response header ${header.name}`)),
  ]
}

/**
 * True for a header a bot-protection vendor adds to requests or responses (`x-kpsdk-ct`,
 * `x-px-*`, `x-datadome-*`, `x-aws-waf-token`): its value is a challenge token or sensor
 * answer only a real browser produces, so it is redacted like a cookie wherever it appears.
 */
export function isBotProtectionHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return BOT_PROTECTION_SIGNATURES.some(signature => [
    ...signature.requestHeaders,
    ...signature.responseHeaders,
  ].some(pattern => pattern.test(lower)))
}

/**
 * True when the calls of an operation carry headers a bot-protection script adds (`x-kpsdk-ct`,
 * `x-px-*`): the site checks a browser-made token on it, whatever other calls showed.
 */
export function sendsBotProtectionHeaders(operation: Pick<Operation, 'headers'>): boolean {
  return operation.headers.some(header => isBotProtectionHeader(header.name))
}

/** Vendor name for interstitials recognised by their content rather than a vendor endpoint. */
const CHALLENGE_PAGE = 'Challenge page'

/** Page titles of challenge and block interstitials (`Reddit - Prove your humanity`). */
const CHALLENGE_TITLES: readonly string[] = [
  'just a moment',
  'attention required',
  'prove your humanity',
  'verify you are human',
  'verify you are a human',
  'are you a robot',
  'are you a human',
  'checking your browser',
  'pardon our interruption',
  'human verification',
  'bot verification',
  'access denied',
  'request blocked',
]
/** Markup only challenge or block pages carry; each label says what was matched. */
const CHALLENGE_MARKERS: ReadonlyArray<{ pattern: RegExp, label: string }> = [
  { pattern: /_cf_chl_opt/, label: 'Cloudflare challenge script' },
  { pattern: /\bjs_challenge\b[\s\S]{1,2000}\bjsc_token\b|\bjsc_token\b[\s\S]{1,2000}\bjs_challenge\b/, label: 'JavaScript challenge redirect' },
  { pattern: /blocked by network security/i, label: 'block page' },
  { pattern: /captcha-delivery\.com/, label: 'DataDome captcha' },
  { pattern: /id=["']?px-captcha/, label: 'PerimeterX captcha' },
  { pattern: /\bgokuProps\b|awswaf\.com\/[^"']*challenge\.js/, label: 'AWS WAF challenge' },
]
/** Only the start of a page is read; interstitials put their title and script up front. */
const MAX_CHALLENGE_SCAN = 300_000
const TITLE = /<title[^>]*>([^<]{0,200})<\/title>/i

/**
 * What marks an HTML body as a bot challenge or block page, whatever its status (Reddit answers
 * its JavaScript challenge with 200): a challenge title or challenge-only markup. `null` for an
 * ordinary page. The returned text is one of this file's labels, never text from the page.
 */
export function challengePageMarker(html: string): string | null {
  const head = html.slice(0, MAX_CHALLENGE_SCAN)
  const title = TITLE.exec(head)?.[1]?.toLowerCase().replace(/\s+/g, ' ') ?? ''
  const phrase = CHALLENGE_TITLES.find(candidate => title.includes(candidate))
  if (phrase !== undefined)
    return `title "${phrase}"`
  return CHALLENGE_MARKERS.find(marker => marker.pattern.test(head))?.label ?? null
}

/**
 * True for an exchange classify labelled as a challenge answer standing in for the site's own
 * content: an interstitial page, or a response with a challenge header (`cf-mitigated`,
 * `x-amzn-waf-action`). Vendor endpoints (`/cdn-cgi/challenge-platform/...`) are not.
 */
export function isChallengeAnswer(exchange: Pick<Exchange, 'kind' | 'kindReason'>): boolean {
  return exchange.kind === 'bot-protection'
    && (exchange.kindReason.startsWith(`${CHALLENGE_PAGE}:`) || exchange.kindReason.includes(': response header '))
}

/** The challenge-page evidence of one exchange: an HTML response that is an interstitial. */
function challengePageEvidence(exchange: Exchange): Found[] {
  const body = exchange.response.body
  if (!body || body.text === null || !body.mimeType.includes('html'))
    return []
  const marker = challengePageMarker(body.text)
  return marker === null
    ? []
    : [
        { evidence: `challenge page (${marker})`, isTraffic: true, thirdParty: false },
      ]
}

/**
 * True when response headers mark a challenge by any vendor's signature (`cf-mitigated:
 * challenge`, `x-amzn-waf-action: challenge`). Names are compared in lower case.
 */
export function hasChallengeHeader(headers: ReadonlyArray<{ name: string, value: string }>): boolean {
  return BOT_PROTECTION_SIGNATURES.some(signature => signature.challengeHeaders.some(challenge =>
    headers.some(header => header.name.toLowerCase() === challenge.name && challenge.value.test(header.value))))
}

/**
 * True when a request to `host` (`null` for a relative URL) and `path` would be bot-protection
 * traffic by a signature endpoint: `…token.awswaf.com/…/mp_verify`, `/cdn-cgi/challenge-platform/…`,
 * `www.google.com/recaptcha/…`. Also true for the vendor's scripts at those endpoints.
 */
export function isBotProtectionEndpoint(host: string | null, path: string): boolean {
  return BOT_PROTECTION_SIGNATURES.some(signature => signature.endpoints.some((endpoint) => {
    if (endpoint.domain !== undefined && (host === null || !hostMatchesDomain(host, endpoint.domain)))
      return false
    return !('path' in endpoint) || endpoint.path.test(path)
  }))
}

/**
 * True when `host` is one of a vendor's own hosts (`www.google.com` for reCAPTCHA,
 * `challenges.cloudflare.com` for Turnstile): a challenge frame there protects the page that
 * embeds it, not the vendor.
 */
export function isVendorHost(host: string): boolean {
  return BOT_PROTECTION_SIGNATURES.some(signature => signature.endpoints.some(endpoint => endpoint.domain !== undefined && hostMatchesDomain(host, endpoint.domain)))
}

/** Every signature that matches one exchange. */
export function detectBotProtection(exchange: Exchange, akamaiHosts: ReadonlySet<string>): BotEvidence[] {
  const body = bodyText(exchange)
  const found: BotEvidence[] = BOT_PROTECTION_SIGNATURES.flatMap(signature =>
    [
      ...trafficEvidence(signature, exchange, body),
      ...traceEvidence(signature, exchange),
    ]
      .map(item => ({ vendor: signature.vendor, ...item })))
  // A vendor-specific match already names the vendor; the content check covers the rest.
  if (!found.some(item => item.isTraffic))
    found.push(...challengePageEvidence(exchange).map(item => ({ vendor: CHALLENGE_PAGE, ...item })))
  const { request } = exchange
  if (request.method === 'POST' && akamaiHosts.has(request.host) && looksLikeRandomSensorPath(request.path)) {
    found.push({
      vendor: AKAMAI,
      evidence: 'POST to a random-looking first-party path',
      isTraffic: true,
      thirdParty: false,
    })
  }
  return found
}

/** Hosts whose traffic carries Akamai Bot Manager cookies. */
export function findAkamaiHosts(exchanges: Exchange[]): Set<string> {
  const akamai = BOT_PROTECTION_SIGNATURES.find(signature => signature.vendor === AKAMAI)
  const hosts = new Set<string>()
  for (const exchange of exchanges) {
    const names = [
      ...exchange.request.cookies.map(cookie => cookie.name),
      ...exchange.response.setCookies.map(cookie => cookie.name),
    ]
    if (names.some(name => akamai?.cookies.some(pattern => pattern.test(name))))
      hosts.add(exchange.request.host)
  }
  return hosts
}
