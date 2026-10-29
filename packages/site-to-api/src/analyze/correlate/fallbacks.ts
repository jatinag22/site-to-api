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
 * APIs that only re-encode bytes. When a crypto call and an encoding of its result both match a
 * value (`btoa(encrypt(...))`), the crypto call is the computation worth porting.
 */
const ENCODING_APIS: ReadonlySet<string> = new Set(['btoa', 'atob'])

/**
 * Index of the transform event whose output is the value (or one of its encodings), recorded
 * at or before `before`. Exact outputs beat encoded ones; then a real computation beats a pure
 * encoding step; then the latest call wins, because the page computes the value right before
 * sending it.
 */
export function findTransformEvent(events: readonly CaptureEvent[], variants: readonly Variant[], before: number): number | null {
  let best: { index: number, rank: number, encoding: boolean, ts: number } | null = null
  for (const [index, event] of events.entries()) {
    if (event.t !== 'transform' || event.ts > before)
      continue
    const transforms: MatchTransform[] = variants
      .filter(variant => event.output.includes(variant.value))
      .map(variant => variant.transform)
    if (transforms.length === 0)
      continue
    const candidate = {
      index,
      rank: Math.min(...transforms.map(transform => TRANSFORM_RANK[transform])),
      encoding: ENCODING_APIS.has(event.api),
      ts: event.ts,
    }
    if (!best || isBetterTransform(candidate, best))
      best = candidate
  }
  return best?.index ?? null
}

function isBetterTransform(a: { rank: number, encoding: boolean, ts: number }, b: { rank: number, encoding: boolean, ts: number }): boolean {
  if (a.rank !== b.rank)
    return a.rank < b.rank
  if (a.encoding !== b.encoding)
    return !a.encoding
  return a.ts >= b.ts
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

/** Request field names sites use for a search box's text, normalised. */
const SEARCH_PARAMETERS = new Set([
  'q',
  'query',
  'search',
  'searchterm',
  'searchquery',
  'term',
  'keyword',
  'keywords',
  'text',
])
const SEARCH_WORDS = /search|query|find/i

type ActionEvent = Extract<CaptureEvent, { t: 'action' }>

/** The changed field is the request field: same name, or a search box for a search parameter. */
function isFieldFor(event: ActionEvent, wanted: string, searchParameter: boolean): boolean {
  const candidates = [
    event.field ?? '',
    ...selectorNames(event.selector),
  ]
  return candidates.some(candidate => normalizeField(candidate) === wanted)
    || (searchParameter && [...candidates, event.label].some(text => SEARCH_WORDS.test(text)))
}

/**
 * The form field the person typed this value into: the latest `change` action before the
 * request whose field name, or the name or id in its selector, matches the request field name.
 * A search box is the exception, because its name rarely matches what the site sends (`search`
 * typed, `q` sent; a nameless box, `query` sent): a well-known search parameter matches a field
 * whose name, selector or label says search. The capture records no typed values, so names are
 * all there is to go on. With `stillTyping` (the request is one of several sending ever longer
 * values of the field), the first `change` after the request counts too.
 */
export function findUserInputField(events: readonly CaptureEvent[], name: string, before: number, options: { stillTyping?: boolean } = {}): string | null {
  const wanted = normalizeField(name)
  if (!wanted)
    return null
  const searchParameter = SEARCH_PARAMETERS.has(wanted)
  const actions = events.filter((event): event is ActionEvent => event.t === 'action')
  let field: string | null = null
  for (const event of actions) {
    if (event.ts <= before && event.kind === 'change' && isFieldFor(event, wanted, searchParameter))
      field = event.field ?? name
  }
  if (field !== null || !options.stillTyping)
    return field
  // `change` fires when the field loses focus, after the requests sent on each keystroke. A value
  // still being typed belongs to the next `change`, unless the person clicked or submitted first.
  for (const event of actions) {
    if (event.ts <= before)
      continue
    if (event.kind === 'click' || event.kind === 'submit')
      return null
    if (event.kind === 'change' && isFieldFor(event, wanted, searchParameter))
      return event.field ?? name
  }
  return null
}
