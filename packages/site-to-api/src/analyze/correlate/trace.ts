import type { CaptureEvent, Exchange, ExchangeKind, HtmlLocator, LoadedSession, ValueLocation, ValueTrace } from '../../model'
import type { LocatedValue } from './values'
import type { MatchTransform, Variant } from './variants'
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

function htmlCandidate(exchange: Exchange, text: string, value: string, transform: MatchTransform, locator: HtmlLocator): Candidate {
  const found = locator(text, value)
  return {
    exchange,
    // An empty selector means the value is in the document but no extraction rule was found.
    location: {
      in: 'html',
      selector: found?.selector ?? '',
      attr: found?.attr ?? null,
      pattern: found?.pattern ?? null,
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

function* htmlCandidates(consumer: Exchange, value: string, variants: readonly Variant[], index: SessionIndex, locator: HtmlLocator): Generator<Candidate> {
  for (const { exchange, text } of index.texts) {
    if (!isBefore(exchange, consumer))
      continue
    // Variants come in rank order, so the first hit is the strongest for this document.
    const variant = variants.find(candidate => text.includes(candidate.value))
    if (variant) {
      yield htmlCandidate(exchange, text, variant.value, variant.transform, locator)
      continue
    }
    // `Bearer <token>`, `token=<token>; path=/`: a delimited part of the value is in the page.
    const part = value.split(/[\s,;=&]+/).find(piece => piece.length >= SUBSTRING_MIN_LENGTH && piece !== value && text.includes(piece))
    if (part !== undefined)
      yield htmlCandidate(exchange, text, part, 'substring', locator)
  }
}

function* substringCandidates(consumer: Exchange, sent: LocatedValue, index: SessionIndex): Generator<Candidate> {
  const value = sent.value
  for (const producer of index.producers) {
    const other = producer.value
    const related = other.length >= SUBSTRING_MIN_LENGTH && other !== value && (value.includes(other) || other.includes(value))
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

function findResponseProducer(consumer: Exchange, sent: LocatedValue, variants: readonly Variant[], index: SessionIndex, locator: HtmlLocator): Candidate | null {
  const best = pickBest(htmlCandidates(consumer, sent.value, variants, index, locator), pickBest(exactCandidates(consumer, sent, variants, index), null))
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
        const producer = findResponseProducer(exchange, sent, variants, index, htmlLocator)
        if (producer) {
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
        const fieldName = inputFieldName(sent)
        const field = fieldName === null
          ? null
          : findUserInputField(index.events, fieldName, exchange.startedAt)
        if (field !== null)
          return { kind: 'user-input', field }
        const sessions = seenIn.get(constantKey(exchange, sent.location, sent.value))?.size ?? 0
        if (staticStrings.has(sent.value) || (sessionIds.size >= 2 && sessions === sessionIds.size))
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
