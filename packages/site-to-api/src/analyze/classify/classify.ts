/**
 * Labels every exchange `api`, `page`, `bot-protection`, `asset` or `noise`.
 */
import type { Body, BotProtectionFinding, Exchange, ExchangeKind } from '../../model'
import type { BotEvidence } from './bot-protection'
import { detectBotProtection, findAkamaiHosts, isVendorHost } from './bot-protection'
import { compileHostGlobs } from './host-glob'
import { findNoise, mirrorOf } from './noise-hosts'

interface ClassifyOptions {
  /** Host globs to analyse. Empty: hosts that served a page plus hosts those pages called. */
  include: string[]
  /** Host globs never to analyse; wins over `include`. */
  exclude: string[]
}

interface ClassifyResult {
  /** The same exchanges, in the same order, with `kind` and `kindReason` set. */
  exchanges: Exchange[]
  /** One finding per vendor and protected host, sorted by host then vendor. */
  botProtection: BotProtectionFinding[]
}

const ASSET_TYPES = new Set([
  'image',
  'font',
  'stylesheet',
  'media',
  'script',
  'manifest',
  'texttrack',
])
const CALL_TYPES = new Set([
  'xhr',
  'fetch',
  'other',
  'beacon',
  'ping',
  'eventsource',
])
const FIRE_AND_FORGET_TYPES = new Set(['beacon', 'ping'])
const ASSET_MEDIA = /^(?:image|font|audio|video)\/|^text\/css$|javascript|ecmascript|font/

/** JSON, XML, text, HTML or CSV: what an API call returns as data. */
function isDataBody(body: Body | null): boolean {
  if (!body)
    return false
  if (body.json !== undefined || body.form !== null)
    return true
  const mime = body.mimeType
  return mime.includes('json') || mime.includes('xml') || mime === 'text/plain' || mime === 'text/html'
    || mime === 'text/csv' || mime === 'text/event-stream' || mime === 'application/x-ndjson'
}

function hostOf(url: string | null): string | null {
  if (url === null)
    return null
  try {
    return new URL(url).host
  }
  catch {
    return null
  }
}

/**
 * Hosts analysed when `include` is empty: those that served a document, plus those that received
 * XHR/fetch calls from such documents. Noise domains never count.
 */
function pageHostsOf(exchanges: Exchange[]): Set<string> {
  const pageHosts = new Set<string>()
  for (const exchange of exchanges) {
    if (exchange.resourceType === 'document' && findNoise(exchange.request.host, exchange.request.path) === null)
      pageHosts.add(exchange.request.host)
  }
  return pageHosts
}

function defaultScope(exchanges: Exchange[]): Set<string> {
  const pageHosts = pageHostsOf(exchanges)
  const scope = new Set(pageHosts)
  for (const exchange of exchanges) {
    const pageHost = hostOf(exchange.pageUrl)
    if (CALL_TYPES.has(exchange.resourceType) && pageHost !== null && pageHosts.has(pageHost)
      && findNoise(exchange.request.host, exchange.request.path) === null) {
      scope.add(exchange.request.host)
    }
  }
  return scope
}

function classifyByType(exchange: Exchange): { kind: ExchangeKind, reason: string } {
  const { resourceType, request, response } = exchange
  if (request.method === 'OPTIONS')
    return { kind: 'noise', reason: 'CORS preflight' }
  if (ASSET_TYPES.has(resourceType))
    return { kind: 'asset', reason: `resource type ${resourceType}` }
  if (resourceType === 'document')
    return { kind: 'page', reason: 'document' }
  if (resourceType === 'websocket')
    return { kind: 'noise', reason: 'websocket upgrade; frames are in the capture events' }
  if (!CALL_TYPES.has(resourceType))
    return { kind: 'noise', reason: `resource type ${resourceType}` }
  if (FIRE_AND_FORGET_TYPES.has(resourceType) && !response.body)
    return { kind: 'noise', reason: `${resourceType} without a response` }
  if (isDataBody(response.body))
    return { kind: 'api', reason: `${resourceType} returning ${response.body?.mimeType || 'JSON'}` }
  if (response.body && ASSET_MEDIA.test(response.body.mimeType))
    return { kind: 'asset', reason: `${resourceType} returning ${response.body.mimeType}` }
  if (!response.body && isDataBody(request.body))
    return { kind: 'api', reason: `${resourceType} sending ${request.body?.mimeType || 'data'}` }
  return {
    kind: 'api',
    reason: response.body
      ? `${resourceType} returning ${response.body.mimeType || 'binary data'}`
      : `${resourceType} without a response body`,
  }
}

function addFinding(findings: Map<string, { finding: BotProtectionFinding, evidence: Set<string>, ids: Set<string> }>, host: string, item: BotEvidence, exchangeId: string): void {
  const key = `${host}\u0000${item.vendor}`
  let entry = findings.get(key)
  if (!entry) {
    entry = {
      finding: {
        vendor: item.vendor,
        host,
        evidence: '',
        exchangeIds: [],
      },
      evidence: new Set(),
      ids: new Set(),
    }
    findings.set(key, entry)
  }
  entry.evidence.add(item.evidence)
  entry.ids.add(exchangeId)
}

/**
 * Sets `kind` and `kindReason` on every exchange and collects bot-protection findings.
 *
 * Order of rules: bot-protection traffic (any host, because vendors run their own hosts), known
 * noise domains, the host filter, then resource and media type. Bot-protection findings are
 * attributed to the protected site: the exchange's host, or the page's host when the match was a
 * vendor-run host such as `www.google.com/recaptcha`.
 */
export function classifyExchanges(exchanges: Exchange[], options: ClassifyOptions): ClassifyResult {
  const included = compileHostGlobs(options.include)
  const excluded = compileHostGlobs(options.exclude)
  const scope = options.include.length === 0
    ? defaultScope(exchanges)
    : null
  const inScope = (host: string): boolean => !excluded(host) && (scope
    ? scope.has(host)
    : included(host))
  const akamaiHosts = findAkamaiHosts(exchanges)
  const observedHosts = new Set(exchanges.map(exchange => exchange.request.host.toLowerCase()))
  const findings = new Map<string, { finding: BotProtectionFinding, evidence: Set<string>, ids: Set<string> }>()

  const classified = exchanges.map((exchange): Exchange => {
    const { host, path } = exchange.request
    const evidence = detectBotProtection(exchange, akamaiHosts)
    for (const item of evidence) {
      const protectedHost = item.thirdParty
        ? (hostOf(exchange.pageUrl) ?? host)
        : host
      // A challenge frame's own requests (`bframe` loaded inside the `anchor` frame) have the
      // vendor's page as their page; the site that embeds the frame reports the finding.
      const pageHost = hostOf(exchange.pageUrl)
      if (isVendorHost(protectedHost) && (pageHost === null || isVendorHost(pageHost)))
        continue
      addFinding(findings, protectedHost, item, exchange.id)
    }

    const traffic = evidence.find(item => item.isTraffic)
    const byType = classifyByType(exchange)
    // Vendor scripts and images stay assets: only the calls they make are protection steps.
    if (traffic && byType.kind !== 'asset' && byType.reason !== 'CORS preflight')
      return { ...exchange, kind: 'bot-protection', kindReason: `${traffic.vendor}: ${traffic.evidence}` }

    const noise = findNoise(host, path)
    if (noise !== null)
      return { ...exchange, kind: 'noise', kindReason: `analytics, ads or telemetry (${noise})` }
    const mirrored = mirrorOf(host, observedHosts)
    if (mirrored !== null)
      return { ...exchange, kind: 'noise', kindReason: `fallback mirror of ${mirrored}, which the specs describe` }
    if (excluded(host))
      return { ...exchange, kind: 'noise', kindReason: 'host excluded by hosts.exclude' }
    if (!inScope(host)) {
      return {
        ...exchange,
        kind: 'noise',
        kindReason: scope ? 'host out of scope: it served no page and no page called it' : 'host not in hosts.include',
      }
    }
    return { ...exchange, kind: byType.kind, kindReason: byType.reason }
  })

  // Vendors also set their cookies on unrelated third-party hosts (Cloudflare's `__cf_bm` on CDNs):
  // only protected hosts that are being analysed are worth reporting.
  const botProtection = [
    ...findings.values(),
  ]
    .filter(({ finding }) => inScope(finding.host))
    .map(({ finding, evidence, ids }) => ({
      ...finding,
      evidence: [...evidence].sort().join('; '),
      exchangeIds: [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    }))
    .sort((a, b) => a.host.localeCompare(b.host) || a.vendor.localeCompare(b.vendor))
  return { exchanges: classified, botProtection }
}

/**
 * Which WebSocket connections to analyse, by the same host rules as HTTP: known analytics hosts
 * and `exclude` never count; with `include` set, its globs decide; otherwise a socket counts when
 * its host served a page or a page of such a host opened it, because a real-time host
 * (`rt.site.com`, a hosted push service) usually serves no page of its own.
 */
export function createChannelScope(exchanges: Exchange[], options: ClassifyOptions): (url: { host: string, path: string }, pageUrl: string) => boolean {
  const included = compileHostGlobs(options.include)
  const excluded = compileHostGlobs(options.exclude)
  const pageHosts = options.include.length === 0
    ? pageHostsOf(exchanges)
    : null
  return (url, pageUrl) => {
    if (findNoise(url.host, url.path) !== null || excluded(url.host))
      return false
    if (pageHosts === null)
      return included(url.host)
    const pageHost = hostOf(pageUrl)
    return pageHosts.has(url.host) || (pageHost !== null && pageHosts.has(pageHost) && !excluded(pageHost))
  }
}
