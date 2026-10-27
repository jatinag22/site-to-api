/** Splits a session's traffic into the segments started by each of the person's actions. */
import type { CaptureEvent, Exchange, Flow, Operation } from '../../model'
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
    label: `Load ${path}`,
    pageUrl: safePageUrl(url),
  }
}

function boundaries(events: readonly CaptureEvent[]): Array<{ ts: number, trigger: Trigger }> {
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
      ts: action.ts,
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
    ...boundaries(input.events),
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
