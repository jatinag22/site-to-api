import type {
  BotProtectionFinding,
  ComputedValue,
  Exchange,
  FlowsDocument,
  FlowStep,
  LoadedSession,
  Operation,
  SourceResolver,
  TransformEvent,
  ValueLocation,
  ValueOrigin,
  ValueTrace,
} from '../../model'
import type { DraftStep, Segment, Trigger } from './segments'
import { FLOWS_FORMAT_VERSION } from '../../model'
import { responseText, responseValues } from '../correlate'
import { describeShape, inspectJwt } from '../shape'
import { formatLocation, outputName, slugify, uniqueName } from './locations'
import { splitSession } from './segments'
import { sessionRequirements } from './session'

/** Input of {@link buildFlows}. */
export interface BuildFlowsInput {
  exchanges: Exchange[]
  operations: Operation[]
  sessions: LoadedSession[]
  traces: ValueTrace[]
  sourceResolver: SourceResolver
  botProtection: BotProtectionFinding[]
  toolVersion: string
}

/**
 * Names that mark a value as a credential. A constant with such a name is still written as a
 * shape, because "the same in every session" can also mean "the same account was used".
 */
const CREDENTIAL_NAME = /auth|token|secret|passw|pwd|session|csrf|xsrf|jwt|signature|api[-_]?key|credential/i

/** Transform inputs shorter than this match too many unrelated response values. */
const MIN_USE_LENGTH = 8
/** Transform input previews are cut at 256 chars, so a longer response value starts with one. */
const MIN_PREFIX_LENGTH = 16

interface DraftFlow {
  id: string
  trigger: Trigger
  occurrences: Segment[]
  steps: Array<{ id: string, operation: Operation }>
}

interface StepAddress {
  flowId: string
  stepId: string
}

function locationName(location: ValueLocation): string {
  switch (location.in) {
    case 'path':
      return ''
    case 'body':
      return location.pointer
    case 'html':
      return location.selector
    default:
      return location.name
  }
}

function looksLikeCredential(location: ValueLocation, value: string): boolean {
  return location.in === 'cookie' || CREDENTIAL_NAME.test(locationName(location)) || inspectJwt(value) !== null
}

function compareExchanges(a: Exchange, b: Exchange): number {
  return a.startedAt - b.startedAt || a.seq - b.seq || a.id.localeCompare(b.id)
}

function triggerPhrase(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'load':
      return `on ${trigger.label.replace(/^Load /, 'loading ')}`
    case 'click':
      return `after clicking "${trigger.label}"`
    case 'submit':
      return `after submitting "${trigger.label}"`
    case 'navigate':
      return `after navigating to "${trigger.label}"`
  }
}

function stepSummary(operation: Operation, trigger: Trigger): string {
  const what = operation.summary.trim() || `${operation.method} ${operation.path}`
  return `${what}, ${triggerPhrase(trigger)}`
}

/**
 * Turns traced traffic into `flows.json`: one flow per action the person took (plus the initial
 * page load), each a list of steps with the origin of every input. Flows with the same trigger
 * label and operation sequence in several sessions are merged. Pure and deterministic.
 *
 * Step references: inside a flow's own steps, `step` names a step of the same flow (`s1`). A
 * value produced by another flow is written `<flowId>.<stepId>`, and so are all references in
 * `computedValues`, which belong to no single flow.
 *
 * No secret value is written: only constants that do not look like credentials keep their
 * value; everything else is described by origin or by shape.
 */
export function buildFlows(input: BuildFlowsInput): FlowsDocument {
  const operationByExchange = new Map<string, Operation>()
  for (const operation of input.operations) {
    for (const exchange of operation.exchanges)
      operationByExchange.set(exchange.id, operation)
  }
  const operationOf = (exchange: Exchange): Operation | undefined => operationByExchange.get(exchange.id)
  const sessionById = new Map(input.sessions.map(session => [session.meta.sessionId, session]))
  const sessionIds = [
    ...new Set([
      ...sessionById.keys(),
      ...input.exchanges.map(exchange => exchange.sessionId),
    ]),
  ].sort()
  const exchangesBySession = new Map(sessionIds.map(sessionId => [
    sessionId,
    input.exchanges.filter(exchange => exchange.sessionId === sessionId).sort(compareExchanges),
  ]))

  const groups = new Map<string, Segment[]>()
  for (const sessionId of sessionIds) {
    const session = sessionById.get(sessionId)
    const segments = splitSession({
      sessionId,
      events: session?.events ?? [],
      startUrl: session?.meta.startUrl ?? null,
      exchanges: exchangesBySession.get(sessionId) ?? [],
      operationOf,
    })
    for (const segment of segments) {
      const key = `${segment.trigger.label}\u0000${segment.steps.map(step => step.operation.operationId).join('\u0000')}`
      groups.set(key, [
        ...(groups.get(key) ?? []),
        segment,
      ])
    }
  }

  const flowIds = new Set<string>()
  const stepOf = new Map<string, StepAddress>()
  const drafts: DraftFlow[] = [
    ...groups.values(),
  ].flatMap((occurrences) => {
    const first = occurrences[0]
    if (!first)
      return []
    const id = uniqueName(slugify(first.trigger.label, 'flow'), flowIds)
    const steps = first.steps.map((step, index) => ({ id: `s${index + 1}`, operation: step.operation }))
    for (const occurrence of occurrences) {
      occurrence.steps.forEach((step, index) => {
        for (const exchange of step.exchanges)
          stepOf.set(exchange.id, { flowId: id, stepId: `s${index + 1}` })
      })
    }
    return [
      {
        id,
        trigger: first.trigger,
        occurrences,
        steps,
      },
    ]
  })

  const tracesByExchange = new Map<string, ValueTrace[]>()
  for (const trace of input.traces) {
    tracesByExchange.set(trace.exchangeId, [
      ...(tracesByExchange.get(trace.exchangeId) ?? []),
      trace,
    ])
  }

  // Response locations each step must expose, keyed by `flowId\0stepId`, then location text.
  const references = new Map<string, Map<string, ValueLocation>>()
  const reference = (producerId: string, location: ValueLocation, currentFlow: string | null): string | null => {
    const address = stepOf.get(producerId)
    if (!address)
      return null
    const key = `${address.flowId}\u0000${address.stepId}`
    const locations = references.get(key) ?? new Map<string, ValueLocation>()
    locations.set(formatLocation(location), location)
    references.set(key, locations)
    return address.flowId === currentFlow
      ? address.stepId
      : `${address.flowId}.${address.stepId}`
  }

  const responseOrigin = (producerId: string, location: ValueLocation, transform: Extract<ValueOrigin, { kind: 'step' }>['transform'], value: string, currentFlow: string | null): ValueOrigin => {
    const step = reference(producerId, location, currentFlow)
    if (step === null) {
      return {
        kind: 'unknown',
        shape: describeShape(value),
      }
    }
    if (location.in === 'html') {
      const confidence = location.selector === ''
        ? 'low'
        : 'high'
      return {
        kind: 'html',
        step,
        selector: location.selector,
        attr: location.attr,
        pattern: location.pattern,
        confidence,
      }
    }
    return {
      kind: 'step',
      step,
      output: formatLocation(location),
      transform,
    }
  }

  const transformEvent = (sessionId: string, eventIndex: number): TransformEvent | null => {
    const event = sessionById.get(sessionId)?.events[eventIndex]
    return event?.t === 'transform'
      ? event
      : null
  }

  // Response values the transform read: a public key, a nonce, a salt from an earlier response.
  const usesOf = (event: TransformEvent, sessionId: string): ValueOrigin[] => {
    const producers = (exchangesBySession.get(sessionId) ?? []).filter(exchange => exchange.startedAt <= event.ts && stepOf.has(exchange.id))
    const uses = new Map<string, ValueOrigin>()
    for (const preview of event.inputs.filter(text => text.length >= MIN_USE_LENGTH)) {
      for (const exchange of producers) {
        const values = responseValues(exchange)
        const exact = values.find(value => value.value === preview || (preview.length >= MIN_PREFIX_LENGTH && value.value.startsWith(preview)))
        const contained = exact ?? values.find(value => value.value.length >= MIN_USE_LENGTH && preview.includes(value.value))
        let origin: ValueOrigin | null = null
        if (contained) {
          origin = responseOrigin(exchange.id, contained.location, exact ? 'none' : 'substring', contained.value, null)
        }
        else if (responseText(exchange)?.includes(preview)) {
          origin = responseOrigin(exchange.id, {
            in: 'html',
            selector: '',
            attr: null,
            pattern: null,
          }, 'none', preview, null)
        }
        if (origin) {
          uses.set(JSON.stringify(origin), origin)
          break
        }
      }
    }
    return [
      ...uses.values(),
    ]
  }

  const computedIds = new Set<string>()
  const computed = new Map<string, ComputedValue>()
  const computedOrigin = (trace: ValueTrace, exchange: Exchange, operation: Operation, inputKey: string, eventIndex: number, sessionId: string): ValueOrigin => {
    const key = `${operation.operationId}\u0000${inputKey}`
    const existing = computed.get(key)
    if (existing)
      return { kind: 'computed', computedId: existing.id }
    const event = transformEvent(sessionId, eventIndex)
    if (!event) {
      return {
        kind: 'unknown',
        shape: describeShape(trace.value),
      }
    }
    const id = uniqueName(slugify(`${operation.operationId}-${inputKey}`, 'computed'), computedIds)
    computed.set(key, {
      id,
      operationId: operation.operationId,
      input: inputKey,
      producedBy: input.sourceResolver.callSite(event.stack, sessionId),
      calledFrom: exchange.initiator
        ? input.sourceResolver.callSite(exchange.initiator.stack, exchange.sessionId)
        : null,
      api: event.api,
      details: event.details,
      uses: usesOf(event, sessionId),
      evidence: 'transform-hook',
    })
    return { kind: 'computed', computedId: id }
  }

  const originOf = (trace: ValueTrace, exchange: Exchange, operation: Operation, flowId: string): ValueOrigin => {
    const origin = trace.origin
    switch (origin.kind) {
      case 'response':
        return responseOrigin(origin.exchangeId, origin.location, origin.transform, trace.value, flowId)
      case 'transform':
        return computedOrigin(trace, exchange, operation, formatLocation(trace.location), origin.eventIndex, origin.sessionId)
      case 'user-input':
        return { kind: 'user-input', field: origin.field }
      case 'constant':
        return looksLikeCredential(trace.location, trace.value)
          ? {
              kind: 'unknown',
              shape: describeShape(trace.value),
            }
          : { kind: 'constant', value: trace.value }
      case 'browser':
        return { kind: 'browser', note: origin.note }
      case 'unknown':
        return {
          kind: 'unknown',
          shape: describeShape(trace.value),
        }
    }
  }

  const flows = drafts.map((draft) => {
    const steps = draft.steps.map((draftStep, index): FlowStep => {
      const occurrences = draft.occurrences.flatMap((occurrence) => {
        const step: DraftStep | undefined = occurrence.steps[index]
        return step
          ? [step]
          : []
      })
      const inputs = new Map<string, ValueOrigin>()
      // The first session decides; a later session only fills in what the first could not trace.
      for (const occurrence of occurrences) {
        const exchange = occurrence.exchanges[0]
        if (!exchange)
          continue
        for (const trace of tracesByExchange.get(exchange.id) ?? []) {
          const key = formatLocation(trace.location)
          const existing = inputs.get(key)
          if (existing && existing.kind !== 'unknown')
            continue
          const origin = originOf(trace, exchange, draftStep.operation, draft.id)
          if (!existing || origin.kind !== 'unknown')
            inputs.set(key, origin)
        }
      }
      const representative = occurrences[0]?.exchanges[0]
      return {
        id: draftStep.id,
        operationId: draftStep.operation.operationId,
        kind: draftStep.operation.kind,
        browserOnly: draftStep.operation.kind === 'bot-protection',
        summary: stepSummary(draftStep.operation, draft.trigger),
        sentFrom: representative?.initiator
          ? input.sourceResolver.callSite(representative.initiator.stack, representative.sessionId)
          : null,
        inputs: Object.fromEntries(inputs),
        outputs: {},
        observedIn: occurrences.flatMap(step => step.exchanges.map(exchange => exchange.id)),
      }
    })
    return {
      id: draft.id,
      name: draft.trigger.label,
      trigger: draft.trigger,
      steps,
      seenInSessions: new Set(draft.occurrences.map(occurrence => occurrence.sessionId)).size,
    }
  })

  // Outputs last: only now is every reference to each step known.
  for (const flow of flows) {
    for (const step of flow.steps) {
      const locations = references.get(`${flow.id}\u0000${step.id}`)
      if (!locations)
        continue
      const names = new Set<string>()
      const entries = [...locations].sort(([a], [b]) => a.localeCompare(b))
      const named = entries.map(([text, location]): [string, string] => [
        uniqueName(outputName(location), names),
        text,
      ])
      step.outputs = Object.fromEntries(named.sort(([a], [b]) => a.localeCompare(b)))
    }
  }

  const allExchanges = sessionIds.flatMap(sessionId => exchangesBySession.get(sessionId) ?? [])
  return {
    formatVersion: FLOWS_FORMAT_VERSION,
    generatedBy: `site-to-api ${input.toolVersion}`,
    sessions: sessionIds,
    session: sessionRequirements({
      exchanges: allExchanges,
      operations: input.operations,
      traces: input.traces,
      botProtection: input.botProtection,
      operationOf,
    }),
    flows,
    computedValues: [
      ...computed.values(),
    ],
  }
}
