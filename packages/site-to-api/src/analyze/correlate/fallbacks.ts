/**
 * Origins for values that no captured response produced: computed by the page, typed by the
 * person, constant, or set by a script in the browser.
 */
import type { CaptureEvent, Exchange } from '../../model'
import type { MatchTransform, Variant } from './variants'
import { requestValues } from './values'
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

/**
 * Text a person searched for in the capture: values of search parameters (`q`, `query`,
 * `search_query`…) in queries, forms and JSON bodies, three characters or more, with `+` and
 * percent-encoded forms. Extraction patterns must not anchor on them (decision 0054).
 */
export function searchedTexts(exchanges: readonly Exchange[]): string[] {
  const texts = new Set<string>()
  for (const exchange of exchanges) {
    for (const sent of requestValues(exchange)) {
      if (sent.name === null || sent.location.in === 'path' || !isSearchName(sent.name) || sent.value.trim().length < 3)
        continue
      texts.add(sent.value)
      texts.add(sent.value.replace(/ /g, '+'))
      texts.add(encodeURIComponent(sent.value))
    }
  }
  return [...texts].sort()
}

function isSearchName(name: string): boolean {
  const wanted = normalizeField(name)
  return SEARCH_PARAMETERS.has(wanted) || SEARCH_WORDS.test(name)
}

/** The changed field is the request field: same name, or a search box for a search parameter. */
function isFieldFor(event: ActionEvent, wanted: string, searchParameter: boolean): boolean {
  const candidates = [
    event.field ?? '',
    ...selectorNames(event.selector),
  ]
  return candidates.some(candidate => normalizeField(candidate) === wanted)
    || (searchParameter && [...candidates, event.label].some(text => SEARCH_WORDS.test(text)))
}

/** How long after a request a field's `change` may still explain it: blur on navigation. */
const CHANGE_AFTER_NAVIGATION_MS = 2000

/**
 * The form field the person typed this value into: the latest `change` action before the
 * request whose field name, or the name or id in its selector, matches the request field name.
 * A search box is the exception, because its name rarely matches what the site sends (`search`
 * typed, `q` sent; a nameless box, `query` sent): a well-known search parameter matches a field
 * whose name, selector or label says search. The capture records no typed values, so names are
 * all there is to go on. With `stillTyping` (the request is one of several sending ever longer
 * values of the field), the first `change` after the request counts too. With `navigation` (the
 * request loads a page), a `change` up to two seconds after it counts: typing and pressing
 * Enter loads the page before the field loses focus.
 */
export function findUserInputField(events: readonly CaptureEvent[], name: string, before: number, options: { stillTyping?: boolean, navigation?: boolean } = {}): string | null {
  const wanted = normalizeField(name)
  if (!wanted)
    return null
  const searchParameter = SEARCH_PARAMETERS.has(wanted)
  const matches = (event: ActionEvent): boolean => event.kind === 'change' && isFieldFor(event, wanted, searchParameter)
  const actions = events.filter((event): event is ActionEvent => event.t === 'action')
  const typed = actions.findLast(event => event.ts <= before && matches(event))
    // Typing then pressing Enter loads the next page first; the field's `change` fires as the
    // old page loses focus, just after. The value in the navigation was still typed.
    ?? (options.navigation === true
      ? actions.find(event => event.ts > before && event.ts - before <= CHANGE_AFTER_NAVIGATION_MS && matches(event))
      : undefined)
    ?? (options.stillTyping === true
      ? nextChange(actions, before, matches)
      : undefined)
  return typed === undefined
    ? null
    : typed.field ?? name
}

/**
 * `change` fires when the field loses focus, after the requests sent on each keystroke: a value
 * still being typed belongs to the next `change`, unless the person clicked or submitted first.
 */
function nextChange(actions: readonly ActionEvent[], before: number, matches: (event: ActionEvent) => boolean): ActionEvent | undefined {
  for (const event of actions) {
    if (event.ts <= before)
      continue
    if (event.kind === 'click' || event.kind === 'submit')
      return undefined
    if (matches(event))
      return event
  }
  return undefined
}
