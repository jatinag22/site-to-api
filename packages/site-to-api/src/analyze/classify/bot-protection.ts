/**
 * Bot-protection signatures. Detection only labels traffic so flows can mark it browser-only and
 * AGENT.md can name the vendor (decision 0008); nothing here helps to reproduce or bypass it.
 *
 * To add a vendor, append a {@link BotProtectionSignature}. `endpoints`, `bodies` and
 * `challengeHeaders` mark the exchange itself as bot-protection traffic. `cookies`,
 * `requestHeaders` and `responseHeaders` are evidence only: the site's real API calls carry them
 * too and must stay `api`.
 */
import type { Exchange } from '../../model'
import { hostMatchesDomain } from './noise-hosts'

interface BotProtectionSignature {
  vendor: string
  /** Vendor hosts (domain suffix) and/or path patterns; every given part must match. */
  endpoints: Array<{ domain?: string, path?: RegExp }>
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
      { path: /^\/akam\/\d+\// },
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
      { path: /^\/cdn-cgi\/challenge-platform\// },
    ],
    bodies: [],
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
      { path: /\/api\/v2\/collector/ },
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
      { path: /\/_Incapsula_Resource/ },
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
      { path: /^\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(?:fp|tl|mfc|p\.js|ips\.js)$/i },
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
      { domain: 'www.google.com', path: /^\/recaptcha\// },
      { domain: 'www.gstatic.com', path: /^\/recaptcha\// },
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
    const hostOk = endpoint.domain === undefined || hostMatchesDomain(request.host, endpoint.domain)
    const pathOk = endpoint.path === undefined || endpoint.path.test(request.path)
    if (hostOk && pathOk)
      found.push({ evidence: `request to ${request.host}${endpoint.path ? request.path : ''}`, isTraffic: true, thirdParty: endpoint.domain !== undefined })
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

/** Every signature that matches one exchange. */
export function detectBotProtection(exchange: Exchange, akamaiHosts: ReadonlySet<string>): BotEvidence[] {
  const body = bodyText(exchange)
  const found: BotEvidence[] = BOT_PROTECTION_SIGNATURES.flatMap(signature =>
    [
      ...trafficEvidence(signature, exchange, body),
      ...traceEvidence(signature, exchange),
    ]
      .map(item => ({ vendor: signature.vendor, ...item })))
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
