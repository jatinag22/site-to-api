/**
 * Analytics, advertising, tag-manager, consent and telemetry services. Their traffic is never part
 * of a site's own API, so it is labelled `noise` even when a page calls it.
 *
 * To extend: add the registrable domain (subdomains match automatically) to {@link NOISE_DOMAINS},
 * or a host + path prefix to {@link NOISE_ENDPOINTS} when the domain also serves real content.
 */

const NOISE_DOMAINS: readonly string[] = [
  // Google analytics, tags and ads
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'googletagservices.com',
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
  'adservice.google.com',
  'pagead2.googlesyndication.com',
  'region1.google-analytics.com',
  'stats.g.doubleclick.net',
  'googleoptimize.com',
  // Meta, Microsoft, LinkedIn, X, TikTok, Pinterest, Snap, Reddit, Yandex, Baidu
  'connect.facebook.net',
  'pixel.facebook.com',
  'clarity.ms',
  'bat.bing.com',
  'px.ads.linkedin.com',
  'snap.licdn.com',
  'analytics.twitter.com',
  'static.ads-twitter.com',
  'ads-api.twitter.com',
  'analytics.tiktok.com',
  'ct.pinterest.com',
  'tr.snapchat.com',
  'sc-static.net',
  'alb.reddit.com',
  'mc.yandex.ru',
  'mc.yandex.com',
  'hm.baidu.com',
  // Product analytics and session replay
  'hotjar.com',
  'hotjar.io',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'mxpnl.com',
  'amplitude.com',
  'heap.io',
  'heapanalytics.com',
  'fullstory.com',
  'mouseflow.com',
  'crazyegg.com',
  'logrocket.io',
  'lr-ingest.io',
  'lr-in-prod.com',
  'posthog.com',
  'plausible.io',
  'matomo.cloud',
  'quantummetric.com',
  'contentsquare.net',
  'smartlook.com',
  'inspectlet.com',
  'kissmetrics.io',
  'chartbeat.com',
  'chartbeat.net',
  'parsely.com',
  'omtrdc.net',
  '2o7.net',
  'demdex.net',
  'everesttech.net',
  'adobedtm.com',
  'tealiumiq.com',
  'tiqcdn.com',
  // Error and performance telemetry
  'sentry.io',
  'sentry-cdn.com',
  'ingest.sentry.io',
  'browser.sentry-cdn.com',
  'bugsnag.com',
  'bugsnag.io',
  'nr-data.net',
  'newrelic.com',
  'browser-intake-datadoghq.com',
  'browser-intake-datadoghq.eu',
  'datadoghq-browser-agent.com',
  'rum.hlx.page',
  // Akamai mPulse real-user monitoring (boomerang beacons and config)
  'go-mpulse.net',
  'akstat.io',
  'telemetry.algolia.com',
  'insights.algolia.io',
  'intake-analytics.wikimedia.org',
  'intake-logging.wikimedia.org',
  'cloudflareinsights.com',
  'speedcurve.com',
  'raygun.io',
  'rollbar.com',
  'trackjs.com',
  // Header bidding (Prebid partners and identity syncs) and supply-side platforms seen on
  // Stack Overflow: ID5, Kargo, Media.net, Aditude, AppNexus/Xandr, TripleLift, Sharethrough,
  // Index Exchange, 33Across, Amobee (turn.com), Moloco, Yahoo, Epsilon (dotomi), Simpli.fi
  'id5-sync.com',
  'eu-1-id5-sync.com',
  'kargo.com',
  'media.net',
  'aditude.io',
  'aditude.cloud',
  'prebid.cloud',
  'adnxs-simple.com',
  '3lift.com',
  'sharethrough.com',
  'indexww.com',
  '33across.com',
  'turn.com',
  'amspbs.com',
  'brand-display.com',
  'adtrafficquality.google',
  'dsp-api.moloco.com',
  'mxptint.net',
  'ssp.wp.pl',
  'ad-m.asia',
  'blismedia.com',
  'simpli.fi',
  'analytics.yahoo.com',
  'dotomi.com',
  'lijit.com',
  'gumgum.com',
  'doubleverify.com',
  // Ad networks and measurement
  'adnxs.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'scorecardresearch.com',
  'quantserve.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'amazon-adsystem.com',
  'adsrvr.org',
  'moatads.com',
  'serving-sys.com',
  'bidswitch.net',
  'smartadserver.com',
  'teads.tv',
  'yieldmo.com',
  'zemanta.com',
  'mathtag.com',
  'agkn.com',
  'bluekai.com',
  'krxd.net',
  'exelator.com',
  'rlcdn.com',
  'tapad.com',
  // Experimentation and session analytics: Optimizely's event API (logx), Contentsquare
  'logx.optimizely.com',
  'contentsquare.com',
  // Ad retargeting and attribution: RTB House, Amazon Ads, Singular, Reddit and Pinterest pixels
  'creativecdn.com',
  'singular.net',
  'pixel-config.reddit.com',
  'trk.pinterest.com',
  'analytics-ipv6.tiktokw.us',
  // Attribution and marketing automation
  'branch.io',
  'app.link',
  'appsflyer.com',
  'adjust.com',
  'onelink.me',
  'braze.com',
  'iterable.com',
  'clevertap-prod.com',
  'wzrkt.com',
  'moengage.com',
  'webengage.com',
  'webengage.co',
  'netcoresmartech.com',
  'hubspot.com',
  'hs-analytics.net',
  'hs-scripts.com',
  'hsforms.net',
  'marketo.net',
  'mktoresp.com',
  'pardot.com',
  'klaviyo.com',
  'onesignal.com',
  'pushwoosh.com',
  'izooto.com',
  // Consent banners
  'cookielaw.org',
  'onetrust.com',
  'cookiebot.com',
  'consensu.org',
  'trustarc.com',
  'usercentrics.eu',
  'didomi.io',
  'quantcast.com',
]

/**
 * Telemetry hosts named by convention rather than one domain: server-side Google Tag Manager runs
 * on a first-party `sgtm.` subdomain, and Amazon's client telemetry on `unagi[-region].amazon.<tld>`.
 */
const NOISE_HOST_PATTERNS: ReadonlyArray<{ pattern: RegExp, label: string }> = [
  { pattern: /^sgtm\./, label: 'server-side Google Tag Manager (sgtm.*)' },
  { pattern: /^unagi(?:-[a-z]+)?\.amazon\.[a-z.]+$/, label: 'Amazon client telemetry (unagi)' },
]

/** Noise on domains that also serve real content: host suffix + path prefix. */
const NOISE_ENDPOINTS: ReadonlyArray<{ domain: string, pathPrefix: string }> = [
  { domain: 'www.facebook.com', pathPrefix: '/tr' },
  { domain: 'www.google.com', pathPrefix: '/pagead/' },
  { domain: 'www.google.com', pathPrefix: '/ads/' },
  { domain: 'www.google.com', pathPrefix: '/ccm/' },
  { domain: 'www.youtube.com', pathPrefix: '/api/stats/' },
  { domain: 'www.linkedin.com', pathPrefix: '/li/track' },
  // Datadog RUM through the app host; Algolia's client pinging its search hosts for health.
  { domain: 'datadoghq.com', pathPrefix: '/rum/' },
  { domain: 'datadoghq.eu', pathPrefix: '/rum/' },
  { domain: 'algolia.net', pathPrefix: '/1/isalive' },
  // Retail ad-exchange beacons on a shop's own host (Temu's cookie-matching pixels)
  { domain: 'temu.com', pathPrefix: '/api/adx/' },
  { domain: 'algolianet.com', pathPrefix: '/1/isalive' },
]

/** `<app>-1.algolianet.com`: the Algolia client's fallback copies of `<app>-dsn.algolia.net`. */
const ALGOLIA_MIRROR = /^([a-z0-9]+)-\d+\.algolianet\.com$/i

/**
 * The host a fallback mirror duplicates, when that host is in `hosts`: the Algolia client retries
 * the same query on `<app>-1..3.algolianet.com` when `<app>-dsn.algolia.net` is slow, so their
 * operations would repeat the main host's. `null` for any other host, or when the capture only
 * reached the mirror.
 */
export function mirrorOf(host: string, hosts: ReadonlySet<string>): string | null {
  const app = ALGOLIA_MIRROR.exec(host.replace(/:\d+$/, ''))?.[1]?.toLowerCase()
  if (app === undefined)
    return null
  return [`${app}-dsn.algolia.net`, `${app}.algolia.net`].find(candidate => hosts.has(candidate)) ?? null
}

/** True when `host` is `domain` or one of its subdomains. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

/** The noise entry that matches, as text for the classification reason, or `null`. */
export function findNoise(host: string, path: string): string | null {
  const domain = NOISE_DOMAINS.find(entry => hostMatchesDomain(host, entry))
  if (domain)
    return domain
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  const named = NOISE_HOST_PATTERNS.find(entry => entry.pattern.test(hostname))
  if (named)
    return named.label
  const endpoint = NOISE_ENDPOINTS.find(entry => hostMatchesDomain(host, entry.domain) && path.startsWith(entry.pathPrefix))
  return endpoint
    ? `${endpoint.domain}${endpoint.pathPrefix}`
    : null
}
