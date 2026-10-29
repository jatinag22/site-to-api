import type { CaptureEvent, Exchange, ExchangeKind, HtmlLocator, LoadedSession, ValueLocation, ValueTrace } from '../../model'
import type { LocatedValue } from './values'
import type { MatchTransform, Variant } from './variants'
import { registrableHost } from '../../capture'
import { browserCookieNote, findTransformEvent, findUserInputField } from './fallbacks'
import { isTrivial } from './trivial'
import { requestValues, responseText, responseValues } from './values'
import { TRANSFORM_RANK, variantsOf } from './variants'

/** Input of {@link traceValues}. */
export interface TraceValuesInput {
  exchanges: Exchange[]
  sessions: LoadedSession[]
  htmlLocator: HtmlLocator
  /** String literals found in the site's scripts; a value among them is a constant. */
  staticStrings: ReadonlySet<string>
  /** Values shorter than this are never traced (small integers have their own rule). */
  minValueLength: number
}

/** Exchanges that send traceable values and whose responses can produce them. */
const TRACED_KINDS: ReadonlySet<ExchangeKind> = new Set<ExchangeKind>(['api', 'page', 'bot-protection'])

/**
 * Shortest value that may match as part of a longer one. Below this, unrelated values contain
 * each other by chance (`abc` inside `abcdef`).
 */
const SUBSTRING_MIN_LENGTH = 8

interface Producer extends LocatedValue {
  exchange: Exchange
}

interface SessionIndex {
  /** Structured response values in capture order. */
  producers: Producer[]
  byValue: Map<string, Producer[]>
  texts: Array<{ exchange: Exchange, text: string }>
  counts: Map<string, number>
  events: readonly CaptureEvent[]
}

interface Candidate {
  exchange: Exchange
  location: ValueLocation
  transform: MatchTransform
  /** The producer field has the same name as the request field, e.g. Set-Cookie for a cookie. */
  sameName: boolean
}

type Origin = ValueTrace['origin']

function compareExchanges(a: Exchange, b: Exchange): number {
  return a.sessionId.localeCompare(b.sessionId) || a.startedAt - b.startedAt || a.seq - b.seq || a.id.localeCompare(b.id)
}

function isBefore(producer: Exchange, consumer: Exchange): boolean {
  return producer.startedAt < consumer.startedAt || (producer.startedAt === consumer.startedAt && producer.seq < consumer.seq)
}

/** Exact beats encoded, a same-named field beats any other, then the earliest producer wins. */
function isBetter(a: Candidate, b: Candidate): boolean {
  const order = (TRANSFORM_RANK[a.transform] - TRANSFORM_RANK[b.transform])
    || (Number(b.sameName) - Number(a.sameName))
    || (a.exchange.startedAt - b.exchange.startedAt)
    || (a.exchange.seq - b.exchange.seq)
    || JSON.stringify(a.location).localeCompare(JSON.stringify(b.location))
  return order < 0
}

function buildIndex(exchanges: readonly Exchange[], events: readonly CaptureEvent[]): SessionIndex {
  const index: SessionIndex = {
    producers: [],
    byValue: new Map(),
    texts: [],
    counts: new Map(),
    events,
  }
  for (const exchange of exchanges) {
    for (const value of responseValues(exchange)) {
      const producer: Producer = { ...value, exchange }
      index.producers.push(producer)
      const list = index.byValue.get(value.value)
      if (list)
        list.push(producer)
      else
        index.byValue.set(value.value, [producer])
      index.counts.set(value.value, (index.counts.get(value.value) ?? 0) + 1)
    }
    const text = responseText(exchange)
    if (text !== null)
      index.texts.push({ exchange, text })
  }
  return index
}

/** Letters only, maybe joined by `-` or `_`: `combined`, `tick`, `SUBSCRIBE`, `price-update`. */
const PLAIN_WORD = /^\p{L}+(?:[-_]\p{L}+)*$/u
const INTEGER_TEXT = /^\d+$/

/** Attributes that carry data or links, so a word inside them (`/stores/pine-hill`) is a value. */
const DATA_ATTRIBUTE = /^(?:href|src|action|value|content|data-.+)$/
/** Attributes that style or name an element: a word in them is markup, not data. */
const MARKUP_ATTRIBUTE = /^(?:class|id|style)$/
/** What may come right before a word taken out of a link: a path, query or fragment separator. */
const URL_BOUNDARY = /[/=?&#:]$/

function siteOf(host: string): string {
  return registrableHost(host.replace(/:\d+$/, ''))
}

/** Where a word sits in the page, and whether that place is evidence the request copied it. */
interface PlainWordPlace {
  found: NonNullable<ReturnType<HtmlLocator>>
  /** Host of the page the word is in, and of the request that sent it. */
  pageHost: string
  requestHost: string
}

/**
 * A plain word is in almost every large page somewhere: a script, a class name, prose, a link to
 * another site. It only counts as copied from the page when the page is on the request's own site
 * and an attribute or element holds exactly that word (not a class, id or style), or it is a whole
 * URL part of a link to that same site (`/stores/pine-hill`, not `manifest-web-player` or `wired.com/story`).
 */
function isPlainWordSource({ found, pageHost, requestHost }: PlainWordPlace): boolean {
  if (found.selector === '' || siteOf(pageHost) !== siteOf(requestHost))
    return false
  if (found.attr !== null && MARKUP_ATTRIBUTE.test(found.attr))
    return false
  if (found.pattern === null)
    return true
  const prefix = found.pattern.slice(0, found.pattern.indexOf('('))
  const literal = prefix.replaceAll('\\', '').replace(/^\^\\?s\*/, '')
  const linkedHost = /\/\/([^/]+)/.exec(literal)?.[1]
  // The first path segment of a link (`/cart`, `//www.example.com/cart`) names a page, not a value.
  const firstSegment = /^(?:[a-z]+:)?(?:\/\/[^/]+)?\/$/.test(literal)
  return found.attr !== null && DATA_ATTRIBUTE.test(found.attr) && URL_BOUNDARY.test(prefix) && !firstSegment
    && (linkedHost === undefined || siteOf(linkedHost) === siteOf(requestHost))
}

function htmlCandidate(page: { exchange: Exchange, text: string }, consumer: Exchange, value: string, transform: MatchTransform, locator: HtmlLocator): Candidate | null {
  const found = locator(page.text, value)
  // The value is in the document, but nowhere an extraction rule can read it from: not an
  // origin a wrapper can use, and in a large page usually a coincidence.
  if (found === null)
    return null
  if (PLAIN_WORD.test(value) && !isPlainWordSource({ found, pageHost: page.exchange.request.host, requestHost: consumer.request.host }))
    return null
  return {
    exchange: page.exchange,
    // An empty selector is the whole text document, read with the pattern if there is one.
    location: {
      in: 'html',
      selector: found.selector,
      attr: found.attr,
      pattern: found.pattern,
    },
    transform,
    sameName: false,
  }
}

function producerCandidate(producer: Producer, sent: LocatedValue, transform: MatchTransform): Candidate {
  return {
    exchange: producer.exchange,
    location: producer.location,
    transform,
    sameName: producer.name !== null && producer.name === sent.name,
  }
}

function* exactCandidates(consumer: Exchange, sent: LocatedValue, variants: readonly Variant[], index: SessionIndex): Generator<Candidate> {
  for (const variant of variants) {
    for (const producer of index.byValue.get(variant.value) ?? []) {
      if (isBefore(producer.exchange, consumer))
        yield producerCandidate(producer, sent, variant.transform)
    }
  }
}

/**
 * Searches earlier HTML and text documents for the value. A document is searched by substring,
 * so a value shorter than the minimum trace length (only small integers get this far, see
 * `isTrivial`) is found in almost every page by chance: `page=1` in `initial-scale=1`. Such
 * values are only matched against structured response values.
 */
function* htmlCandidates(consumer: Exchange, sent: LocatedValue, variants: readonly Variant[], index: SessionIndex, locator: HtmlLocator, minValueLength: number): Generator<Candidate> {
  const { value } = sent
  if (value.length < minValueLength)
    return
  for (const page of index.texts) {
    const { exchange, text } = page
    if (!isBefore(exchange, consumer))
      continue
    // Variants come in rank order, so the first hit is the strongest for this document.
    const variant = variants.find(candidate => text.includes(candidate.value))
    if (variant) {
      const candidate = htmlCandidate(page, consumer, variant.value, variant.transform, locator)
      if (candidate)
        yield candidate
      continue
    }
    // `Bearer <token>`, `token=<token>; path=/`: a delimited part of the value is in the page.
    const part = value.split(/[\s,;=&]+/).find(piece => piece.length >= SUBSTRING_MIN_LENGTH && piece !== value && text.includes(piece))
    const candidate = part === undefined
      ? null
      : htmlCandidate(page, consumer, part, 'substring', locator)
    if (candidate)
      yield candidate
  }
}

/** Characters that separate list items, parameters and words: `ids=1,2`, `Bearer x`, `a=1&b=2`. */
const PART_SEPARATOR = /[\s,;=&/|:"']/

/** Joiners in slugs, prefixed ids and file names: `48213377-running-shoe`, `item_48213377`, `48213377.jpg`. */
const JOINER = /[-_.]/
const LETTER = /\p{L}/u

/**
 * Whether the character next to a number (`side`) ends it: the edge of the value, a separator, or
 * a joiner (`-`, `_`, `.`) whose other side (`beyond`) is a letter or the edge, not more digits.
 */
function endsNumber(side: string, beyond: string): boolean {
  if (side === '' || PART_SEPARATOR.test(side))
    return true
  return JOINER.test(side) && (beyond === '' || LETTER.test(beyond))
}

/**
 * Whether `part` sits in `whole` as a part of its own. A number must be set off from other digit
 * groups: `48213377` is a part of `order-48213377` and `48213377.jpg`, but a timestamp inside
 * `1.1.1793209580.1793209580` or a count inside an id is the same clock or counter, not a copy.
 */
function containsAsPart(whole: string, part: string): boolean {
  if (!INTEGER_TEXT.test(part))
    return true
  for (let index = whole.indexOf(part); index !== -1; index = whole.indexOf(part, index + 1)) {
    const end = index + part.length
    if (endsNumber(whole.charAt(index - 1), whole.charAt(index - 2)) && endsNumber(whole.charAt(end), whole.charAt(end + 1)))
      return true
  }
  return false
}

function* substringCandidates(consumer: Exchange, sent: LocatedValue, index: SessionIndex): Generator<Candidate> {
  const value = sent.value
  // A plain word inside a longer text (a description, a sentence) is a coincidence, not a copy.
  if (PLAIN_WORD.test(value))
    return
  for (const producer of index.producers) {
    const other = producer.value
    const related = other.length >= SUBSTRING_MIN_LENGTH && other !== value && !PLAIN_WORD.test(other)
      && ((value.includes(other) && containsAsPart(value, other)) || (other.includes(value) && containsAsPart(other, value)))
    if (related && isBefore(producer.exchange, consumer))
      yield producerCandidate(producer, sent, 'substring')
  }
}

function pickBest(candidates: Iterable<Candidate>, initial: Candidate | null): Candidate | null {
  let best = initial
  for (const candidate of candidates) {
    if (!best || isBetter(candidate, best))
      best = candidate
  }
  return best
}

function findResponseProducer(consumer: Exchange, sent: LocatedValue, variants: readonly Variant[], index: SessionIndex, locator: HtmlLocator, minValueLength: number): Candidate | null {
  const best = pickBest(htmlCandidates(consumer, sent, variants, index, locator, minValueLength), pickBest(exactCandidates(consumer, sent, variants, index), null))
  // Scanning every response value for containment is the slow path; it can only win when
  // nothing better than a substring match was found.
  if ((best && best.transform !== 'substring') || sent.value.length < SUBSTRING_MIN_LENGTH)
    return best
  return pickBest(substringCandidates(consumer, sent, index), best)
}

/** Field names a person can type into: query, form and JSON body fields. */
function inputFieldName(sent: LocatedValue): string | null {
  const kind = sent.location.in
  return kind === 'query' || kind === 'form' || kind === 'body'
    ? sent.name
    : null
}

function constantKey(exchange: Exchange, location: ValueLocation, value: string): string {
  return `${exchange.request.host}\u0000${JSON.stringify(location)}\u0000${value}`
}

/**
 * Values sent while the person was still typing: one session sends the same field of the same
 * host again and again, each value extending the one before (`c`, `ci`, `cip`, ... a search box
 * asking for suggestions on every keystroke).
 */
function typedPrefixChains(exchanges: readonly Exchange[], sentValues: ReadonlyMap<Exchange, LocatedValue[]>): Set<LocatedValue> {
  const byField = new Map<string, LocatedValue[]>()
  for (const exchange of exchanges) {
    for (const sent of sentValues.get(exchange) ?? []) {
      if (inputFieldName(sent) === null)
        continue
      const key = `${exchange.sessionId}\u0000${exchange.request.host}\u0000${JSON.stringify(sent.location)}`
      byField.set(key, [
        ...(byField.get(key) ?? []),
        sent,
      ])
    }
  }
  const typing = new Set<LocatedValue>()
  for (const values of byField.values()) {
    values.forEach((sent, position) => {
      const previous = values[position - 1]
      const next = values[position + 1]
      const grows = (shorter: LocatedValue | undefined, longer: LocatedValue | undefined): boolean =>
        shorter !== undefined && longer !== undefined && longer.value.length > shorter.value.length && longer.value.startsWith(shorter.value)
      if (grows(previous, sent) || grows(sent, next))
        typing.add(sent)
    })
  }
  return typing
}

/** Why a sent value may be the site's constant rather than copied from a response. */
interface ConstantEvidence {
  /** Sent the same in every session (two or more). Deploy-bound ids (a build id) are too. */
  everySession: boolean
  /** Written as a string literal in the site's own code. */
  literal: boolean
}

/**
 * A producer that a constant explains better (the site's own value, found elsewhere by chance).
 * Exact producers of ids, tokens and build ids always win: two captures of one deploy agree on
 * them, yet a wrapper must read them from the response. Only these lose to a constant: a part of
 * a longer value, a plain word in a page (`Indices` in a navigation link), and a plain word a
 * response holds that the site's code also writes as a literal (`NIFTY`). A plain word only equal
 * across sessions (`/api/me` → `jatin` → `/users/jatin`) keeps its producer.
 */
function isCoincidence(producer: Candidate, value: string, evidence: ConstantEvidence): boolean {
  if (!evidence.everySession && !evidence.literal)
    return false
  // A Set-Cookie of the same name is where a cookie comes from, however constant its value.
  if (producer.sameName && producer.location.in === 'set-cookie')
    return false
  if (producer.transform === 'substring')
    return true
  if (!PLAIN_WORD.test(value))
    return false
  return producer.location.in === 'html' || evidence.literal
}

/**
 * Finds the origin of every value the captured requests send: an earlier response (directly or
 * encoded), a computation in the page, the person's typing, a constant, a script-set cookie, or
 * unknown. Output follows capture order (session, time, sequence), then each request's value
 * order (path, query, headers, cookies, body), so the same input always gives the same traces.
 */
export function traceValues(input: TraceValuesInput): ValueTrace[] {
  const { htmlLocator, minValueLength, staticStrings } = input
  const exchanges = input.exchanges.filter(exchange => TRACED_KINDS.has(exchange.kind)).sort(compareExchanges)
  const eventsBySession = new Map(input.sessions.map(session => [session.meta.sessionId, session.events]))
  const sessionIds = new Set([
    ...eventsBySession.keys(),
    ...exchanges.map(exchange => exchange.sessionId),
  ])

  const bySession = new Map<string, Exchange[]>()
  for (const exchange of exchanges) {
    bySession.set(exchange.sessionId, [
      ...(bySession.get(exchange.sessionId) ?? []),
      exchange,
    ])
  }
  const indexes = new Map<string, SessionIndex>()
  for (const [sessionId, list] of bySession)
    indexes.set(sessionId, buildIndex(list, eventsBySession.get(sessionId) ?? []))

  // Sessions in which each (host, location, value) was sent, to find cross-session constants.
  const seenIn = new Map<string, Set<string>>()
  const sentValues = new Map<Exchange, LocatedValue[]>()
  for (const exchange of exchanges) {
    const values = requestValues(exchange)
    sentValues.set(exchange, values)
    for (const sent of values) {
      const key = constantKey(exchange, sent.location, sent.value)
      seenIn.set(key, (seenIn.get(key) ?? new Set()).add(exchange.sessionId))
    }
  }

  const typing = typedPrefixChains(exchanges, sentValues)
  const traces: ValueTrace[] = []
  for (const exchange of exchanges) {
    const index = indexes.get(exchange.sessionId)
    if (!index)
      continue
    const context = {
      minValueLength,
      responseCount: (value: string): number => index.counts.get(value) ?? 0,
    }
    for (const sent of sentValues.get(exchange) ?? []) {
      if (isTrivial(sent.value, sent.location, exchange, context))
        continue
      const variants = variantsOf(sent.value, minValueLength)
      const resolve = (): Origin => {
        const producer = findResponseProducer(exchange, sent, variants, index, htmlLocator, minValueLength)
        const fieldName = inputFieldName(sent)
        const field = fieldName === null
          ? null
          : findUserInputField(index.events, fieldName, exchange.startedAt, {
              stillTyping: typing.has(sent),
            })
        const sessions = seenIn.get(constantKey(exchange, sent.location, sent.value))?.size ?? 0
        const evidence: ConstantEvidence = {
          everySession: sessionIds.size >= 2 && sessions === sessionIds.size,
          literal: staticStrings.has(sent.value),
        }
        const constant = evidence.everySession || evidence.literal
        // Typing `ciphe` after `ciph`: the longer value contains the earlier one, which the
        // response echoed. A typed field explains it better than that substring.
        if (producer && !(producer.transform === 'substring' && field !== null) && !isCoincidence(producer, sent.value, evidence)) {
          return {
            kind: 'response',
            exchangeId: producer.exchange.id,
            location: producer.location,
            transform: producer.transform,
          }
        }
        const eventIndex = findTransformEvent(index.events, variants, exchange.startedAt)
        if (eventIndex !== null)
          return { kind: 'transform', eventIndex, sessionId: exchange.sessionId }
        if (field !== null)
          return { kind: 'user-input', field }
        if (constant)
          return { kind: 'constant' }
        if (sent.location.in === 'cookie') {
          return {
            kind: 'browser',
            note: browserCookieNote(sent.location.name),
          }
        }
        return { kind: 'unknown' }
      }
      traces.push({
        exchangeId: exchange.id,
        location: sent.location,
        value: sent.value,
        origin: resolve(),
      })
    }
  }
  return traces
}
