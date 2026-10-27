/**
 * Origins for values that no captured response produced: computed by the page, typed by the
 * person, constant, or set by a script in the browser.
 */
import type { CaptureEvent } from '../../model'
import type { MatchTransform, Variant } from './variants'
import { TRANSFORM_RANK } from './variants'

/**
 * Cookie name patterns of bot-protection vendors. Their scripts set these cookies in the page,
 * which is why no response produced them (decision 0008: recorded, never reproduced).
 */
const BOT_PROTECTION_COOKIES: ReadonlyArray<{ pattern: RegExp, vendor: string }> = [
  { pattern: /^(?:_abck|bm_sz|bm_sv|bm_mi|ak_bmsc|bm_s|bm_so|sbsd)$/, vendor: 'Akamai Bot Manager' },
  { pattern: /^(?:__cf_bm|cf_clearance|__cflb|_cfuvid)$/, vendor: 'Cloudflare' },
  { pattern: /^_px/, vendor: 'PerimeterX (HUMAN)' },
  { pattern: /^datadome$/, vendor: 'DataDome' },
  { pattern: /^(?:incap_ses_|visid_incap_|nlbi_|reese84)/, vendor: 'Imperva' },
  { pattern: /^(?:KP_UIDz|x-kpsdk)/i, vendor: 'Kasada' },
  { pattern: /^_GRECAPTCHA$/, vendor: 'reCAPTCHA' },
  { pattern: /^aws-waf-token$/, vendor: 'AWS WAF' },
]

/** Bot-protection vendor that sets a cookie with this name, if any. */
export function botProtectionVendor(cookieName: string): string | null {
  return BOT_PROTECTION_COOKIES.find(entry => entry.pattern.test(cookieName))?.vendor ?? null
}

/** The note for a cookie no captured response set. */
export function browserCookieNote(cookieName: string): string {
  const vendor = botProtectionVendor(cookieName)
  return vendor
    ? `set by page script (${vendor})`
    : 'set by page script'
}

/**
 * Index of the transform event whose output is the value (or one of its encodings), recorded
 * at or before `before`. Exact outputs beat encoded ones; among equals the latest call wins,
 * because the page computes the value right before sending it.
 */
export function findTransformEvent(events: readonly CaptureEvent[], variants: readonly Variant[], before: number): number | null {
  let best: { index: number, rank: number, ts: number } | null = null
  for (const [index, event] of events.entries()) {
    if (event.t !== 'transform' || event.ts > before)
      continue
    const transforms: MatchTransform[] = variants
      .filter(variant => event.output.includes(variant.value))
      .map(variant => variant.transform)
    if (transforms.length === 0)
      continue
    const rank = Math.min(...transforms.map(transform => TRANSFORM_RANK[transform]))
    if (!best || rank < best.rank || (rank === best.rank && event.ts >= best.ts))
      best = { index, rank, ts: event.ts }
  }
  return best?.index ?? null
}

function normalizeField(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function selectorNames(selector: string): string[] {
  const names: string[] = []
  for (const match of selector.matchAll(/#([\w-]+)|\[(?:name|id)=["']?([^"'\]]+)["']?\]/g))
    names.push(match[1] ?? match[2] ?? '')
  return names
}

/**
 * The form field the person typed this value into: the latest `change` action before the
 * request whose field name, or the name or id in its selector, matches the request field name.
 */
export function findUserInputField(events: readonly CaptureEvent[], name: string, before: number): string | null {
  const wanted = normalizeField(name)
  if (!wanted)
    return null
  let field: string | null = null
  for (const event of events) {
    if (event.t !== 'action' || event.kind !== 'change' || event.ts > before)
      continue
    const candidates = [
      event.field ?? '',
      ...selectorNames(event.selector),
    ]
    if (candidates.some(candidate => normalizeField(candidate) === wanted))
      field = event.field ?? name
  }
  return field
}
