/** Splits a session's traffic into the segments started by each of the person's actions. */
import type { CaptureEvent, Exchange, Flow, Operation } from '../../model'
import { redactPathTokens } from '../redact'
import { safePageUrl } from './locations'

export type Trigger = Flow['trigger']

/** A step before ids are assigned: one operation and the exchanges it was seen in. */
export interface DraftStep {
  operation: Operation
  exchanges: Exchange[]
}

export interface Segment {
  sessionId: string
  trigger: Trigger
  steps: DraftStep[]
}

const STEP_KINDS = new Set(['api', 'page', 'bot-protection'])

/**
 * A navigation this soon after a click or submit is the result of that action, not a new one:
 * the requests after it still belong to the click that caused it.
 */
const NAVIGATION_FOLLOWS_MS = 2000

/** Cache busters such as `_=1700000000000` vary on every poll; leave them out of the fingerprint. */
const TIMESTAMP = /^\d{10}(?:\d{3})?$/

function loadTrigger(startUrl: string | null, exchanges: readonly Exchange[]): Trigger {
  const page = exchanges.find(exchange => exchange.kind === 'page') ?? exchanges[0]
  const url = startUrl ?? page?.request.url ?? null
  let path = '/'
  if (url) {
    try {
      path = new URL(url).pathname
    }
    catch {
      path = url
    }
  }
  return {
    kind: 'load',
    // The path names the flow (`load-login`); a magic-link token must not end up in it.
    label: `Load ${redactPathTokens(path)}`,
    pageUrl: safePageUrl(url),
  }
}

/** How long before a `navigate` event its document request may have started. */
const DOCUMENT_LEADS_NAVIGATION_MS = 30_000

function withoutHash(url: string): string {
  return url.split('#')[0] ?? url
}

/**
 * When the navigation to `pageUrl` began. The `navigate` event is recorded once the new page's
 * scripts run, after its document request, so a navigation of its own (a typed URL, a script's
 * `page.goto`) would lose its document to the action before it. The first document request for
 * the URL since the previous action (and not too long ago) marks the start. A document that
 * started right after a click or submit is that action's result and stays with it; the first
 * page of the session is the initial load.
 */
function navigationStart(ts: number, pageUrl: string, previous: { ts: number, trigger: Trigger } | undefined, exchanges: readonly Exchange[]): number {
  if (!previous)
    return ts
  const url = withoutHash(pageUrl)
  const caused = previous.trigger.kind === 'click' || previous.trigger.kind === 'submit'
  let start = ts
  for (const exchange of exchanges) {
    const isDocument = exchange.resourceType === 'document' || exchange.kind === 'page'
    const { startedAt } = exchange
    if (!isDocument || startedAt <= previous.ts || startedAt > ts || ts - startedAt > DOCUMENT_LEADS_NAVIGATION_MS || withoutHash(exchange.request.url) !== url)
      continue
    if (caused && startedAt - previous.ts <= NAVIGATION_FOLLOWS_MS)
      return ts
    start = Math.min(start, startedAt)
  }
  return start
}

function boundaries(events: readonly CaptureEvent[], exchanges: readonly Exchange[]): Array<{ ts: number, trigger: Trigger }> {
  const result: Array<{ ts: number, trigger: Trigger }> = []
  const actions = events
    .flatMap(event => (event.t === 'action' && event.kind !== 'change'
      ? [
          { ...event, kind: event.kind },
        ]
      : []))
    .sort((a, b) => a.ts - b.ts)
  for (const action of actions) {
    const previous = result.at(-1)
    if (action.kind === 'navigate' && previous && previous.trigger.kind !== 'navigate' && action.ts - previous.ts <= NAVIGATION_FOLLOWS_MS)
      continue
    result.push({
      ts: action.kind === 'navigate'
        ? navigationStart(action.ts, action.pageUrl, previous, exchanges)
        : action.ts,
      trigger: {
        kind: action.kind,
        label: action.label.replace(/\s+/g, ' ').trim(),
        pageUrl: safePageUrl(action.pageUrl),
      },
    })
  }
  return result
}

function fingerprint(exchange: Exchange): string {
  const query = exchange.request.query
    .filter(pair => !TIMESTAMP.test(pair.value))
    .map(pair => `${pair.name}=${pair.value}`)
    .join('&')
  return `${exchange.request.method} ${exchange.request.host}${exchange.request.path}?${query}\u0000${exchange.request.body?.text ?? ''}`
}

/**
 * Segments of one session in time order. The traffic before the first action is the initial
 * page load. Only `api`, `page` and `bot-protection` exchanges with a known operation become
 * steps; a request repeated with the same operation and the same values (polling) is folded
 * into its first step. Segments without steps are dropped.
 */
export function splitSession(input: {
  sessionId: string
  events: readonly CaptureEvent[]
  startUrl: string | null
  /** The session's exchanges in capture order. */
  exchanges: readonly Exchange[]
  operationOf: (exchange: Exchange) => Operation | undefined
}): Segment[] {
  const starts = [
    {
      ts: Number.NEGATIVE_INFINITY,
      trigger: loadTrigger(input.startUrl, input.exchanges),
    },
    ...boundaries(input.events, input.exchanges),
  ]
  const segments: Array<Segment & { seen: Map<string, DraftStep> }> = starts.map(start => ({
    sessionId: input.sessionId,
    trigger: start.trigger,
    steps: [],
    seen: new Map(),
  }))
  for (const exchange of input.exchanges) {
    const operation = input.operationOf(exchange)
    if (!operation || !STEP_KINDS.has(exchange.kind))
      continue
    let position = 0
    while (position + 1 < starts.length && (starts[position + 1]?.ts ?? Number.POSITIVE_INFINITY) <= exchange.startedAt)
      position++
    const segment = segments[position]
    if (!segment)
      continue
    const key = `${operation.operationId}\u0000${fingerprint(exchange)}`
    const repeated = segment.seen.get(key)
    if (repeated) {
      repeated.exchanges.push(exchange)
      continue
    }
    const step: DraftStep = {
      operation,
      exchanges: [exchange],
    }
    segment.seen.set(key, step)
    segment.steps.push(step)
  }
  return segments
    .filter(segment => segment.steps.length > 0)
    .map(({ sessionId, trigger, steps }) => ({ sessionId, trigger, steps }))
}
