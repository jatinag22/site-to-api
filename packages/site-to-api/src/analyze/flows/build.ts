import type {
  BotProtectionFinding,
  ComputedValue,
  Exchange,
  FlowsDocument,
  FlowStep,
  LoadedSession,
  Operation,
  RedactContext,
  Redactor,
  SourceResolver,
  TransformEvent,
  ValueLocation,
  ValueOrigin,
  ValueTrace,
} from '../../model'
import type { DraftStep, Segment, Trigger } from './segments'
import { FLOWS_FORMAT_VERSION } from '../../model'
import { isBotProtectionHeader } from '../classify'
import { botProtectionVendor, responseText, responseValues } from '../correlate'
import { describeShape } from '../shape'
import { createLocationGeneralizer } from './items'
import { formatLocation, lastPointerToken, outputName, slugify, uniqueName } from './locations'
import { splitSession } from './segments'
import { sessionRequirements } from './session'
import { looksTyped, typedInputField } from './typed-input'

/** Input of {@link buildFlows}. */
export interface BuildFlowsInput {
  exchanges: Exchange[]
  operations: Operation[]
  sessions: LoadedSession[]
  traces: ValueTrace[]
  sourceResolver: SourceResolver
  botProtection: BotProtectionFinding[]
  /**
   * The build's redactor (decision 0004). Every value `flows.json` would copy from the capture
   * (constants, labels, page URLs, HTML anchors) goes through it, so flows and specs agree on
   * what is secret.
   */
  redactor: Redactor
  toolVersion: string
}

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

type HtmlLocation = Extract<ValueLocation, { in: 'html' }>

/** Where a request value sits, in the redactor's terms; for JSON the nearest property name. */
function redactContextOf(location: ValueLocation): RedactContext {
  switch (location.in) {
    case 'path':
      return { in: 'path', name: null }
    case 'body':
      return {
        in: 'body',
        name: lastPointerToken(location.pointer),
      }
    case 'html':
      return { in: 'response-body', name: null }
    default:
      return { in: location.in, name: location.name }
  }
}

/**
 * The literal text of an extraction pattern, without its capture group and regex escapes:
 * `"csrfToken":"([^"]*)` → `"csrfToken":"`. That text was copied from the page.
 */
function patternLiteral(pattern: string): string {
  return pattern
    .replace(/\((?:[^()\\]|\\.)*\)/g, ' ')
    .replace(/\\s\*/g, ' ')
    .replace(/\\(.)/g, '$1')
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

/** `After submitting "Sign in": Get api auth key. Returns keyId, publicKey.` */
function stepSummary(operation: Operation, trigger: Trigger): string {
  const what = operation.summary.trim() || `${operation.method} ${operation.path}.`
  const phrase = triggerPhrase(trigger)
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}: ${what}`
}

/**
 * Whether a traced value is an input a wrapper has to supply. Literal path segments
 * (`/api/stock.txt`) are part of the route, not inputs; bot-protection steps run in a real
 * browser, so their payloads (`sensor_data`) are never inputs (decision 0008).
 */
function isStepInput(trace: ValueTrace, operation: Operation): boolean {
  if (operation.kind === 'bot-protection')
    return false
  if (trace.location.in === 'path') {
    const index = trace.location.index
    return operation.pathParams.some(param => param.index === index)
  }
  return true
}

/**
 * Inputs of one step across every session it was seen in. The first session decides; a later
 * session only fills in what the first could not trace.
 */
function collectInputs(
  occurrences: DraftStep[],
  operation: Operation,
  tracesByExchange: ReadonlyMap<string, ValueTrace[]>,
  originOf: (trace: ValueTrace, exchange: Exchange) => ValueOrigin,
  /** Redacts an input key: JSON pointers can hold data used as keys (`/users/<email>`). */
  safeKey: (key: string) => string,
): Map<string, ValueOrigin> {
  const inputs = new Map<string, ValueOrigin>()
  for (const exchange of occurrences.flatMap(occurrence => occurrence.exchanges.slice(0, 1))) {
    for (const trace of tracesByExchange.get(exchange.id) ?? []) {
      if (!isStepInput(trace, operation))
        continue
      const key = safeKey(formatLocation(trace.location))
      const existing = inputs.get(key)
      if (existing && existing.kind !== 'unknown')
        continue
      const origin = originOf(trace, exchange)
      if (!existing || origin.kind !== 'unknown')
        inputs.set(key, origin)
    }
  }
  return inputs
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
 * No secret value is written: a constant keeps its value only when the redactor leaves it
 * unchanged (the same rule the specs use for header defaults); everything else is described by
 * origin or by shape. Trigger labels, page URLs, HTML selectors and patterns, location texts and
 * computed-value details pass through the redactor too, and token path segments become `{token}`.
 */

/** Why a request value is the bot-protection script's to produce, or `null`: its header or cookie. */
function botProtectionInput(location: ValueTrace['location']): string | null {
  if (location.in === 'header' && isBotProtectionHeader(location.name))
    return 'set by the bot-protection script'
  if (location.in === 'cookie') {
    const vendor = botProtectionVendor(location.name)
    if (vendor !== null)
      return `set by page script (${vendor})`
  }
  return null
}

export function buildFlows(input: BuildFlowsInput): FlowsDocument {
  const { redactor } = input
  /** Text copied from the capture, redacted like any other free text. */
  const safeText = (text: string): string => redactor.value(text, { in: 'text' })
  const leaks = (text: string | null): boolean => text !== null && safeText(text) !== text
  /**
   * HTML selectors and patterns embed page text (`[data-user="..."]`, the words before a value).
   * When that text holds a secret or personal data, fall back to a weaker, value-free location.
   */
  const safeHtmlLocation = (location: HtmlLocation): HtmlLocation => {
    if (leaks(location.selector) || leaks(location.attr)) {
      return {
        in: 'html',
        selector: '',
        attr: null,
        pattern: null,
      }
    }
    if (location.pattern !== null && (leaks(location.pattern) || leaks(patternLiteral(location.pattern))))
      return { ...location, pattern: null }
    return location
  }
  const safeLocation = (location: ValueLocation): ValueLocation => location.in === 'html'
    ? safeHtmlLocation(location)
    : location
  const safeTrigger = (trigger: Trigger): Trigger => ({
    kind: trigger.kind,
    label: safeText(trigger.label),
    pageUrl: safeText(trigger.pageUrl),
  })
  const operationByExchange = new Map<string, Operation>()
  for (const operation of input.operations) {
    for (const exchange of operation.exchanges)
      operationByExchange.set(exchange.id, operation)
  }
  const operationOf = (exchange: Exchange): Operation | undefined => operationByExchange.get(exchange.id)
  const exchangeById = new Map(input.exchanges.map(exchange => [exchange.id, exchange]))

  const generalLocation = createLocationGeneralizer(input.traces, exchangeById, id => operationByExchange.get(id))
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
    for (const raw of segments) {
      const segment = {
        ...raw,
        trigger: safeTrigger(raw.trigger),
      }
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
    locations.set(safeText(formatLocation(location)), location)
    references.set(key, locations)
    return address.flowId === currentFlow
      ? address.stepId
      : `${address.flowId}.${address.stepId}`
  }

  const responseOrigin = (producerId: string, rawLocation: ValueLocation, transform: Extract<ValueOrigin, { kind: 'step' }>['transform'], value: string, currentFlow: string | null): ValueOrigin => {
    const general = generalLocation(producerId, rawLocation)
    const location = safeLocation(general.location)
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
        ...(general.repeated && location.selector !== ''
          ? { repeated: true }
          : {}),
      }
    }
    return {
      kind: 'step',
      step,
      output: safeText(formatLocation(location)),
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
  const responseUse = (preview: string, producers: readonly Exchange[]): ValueOrigin | null => {
    for (const exchange of producers) {
      const values = responseValues(exchange)
      const exact = values.find(value => value.value === preview || (preview.length >= MIN_PREFIX_LENGTH && value.value.startsWith(preview)))
      const contained = exact ?? values.find(value => value.value.length >= MIN_USE_LENGTH && preview.includes(value.value))
      if (contained)
        return responseOrigin(exchange.id, contained.location, exact ? 'none' : 'substring', contained.value, null)
      if (responseText(exchange)?.includes(preview)) {
        return responseOrigin(exchange.id, {
          in: 'html',
          selector: '',
          attr: null,
          pattern: null,
        }, 'none', preview, null)
      }
    }
    return null
  }

  /** Whether any response holds the text, without recording it as a step output. */
  const foundInResponses = (preview: string, exchanges: readonly Exchange[]): boolean => exchanges.some(exchange =>
    responseValues(exchange).some(value => value.value === preview) || (responseText(exchange)?.includes(preview) ?? false))

  const usesOf = (event: TransformEvent, sessionId: string, consumer: Exchange, inputKey: string): ValueOrigin[] => {
    const producers = (exchangesBySession.get(sessionId) ?? []).filter(exchange => exchange.startedAt <= event.ts && stepOf.has(exchange.id))
    const everyResponse = exchangesBySession.get(sessionId) ?? []
    const uses = new Map<string, ValueOrigin>()
    const add = (origin: ValueOrigin): void => {
      uses.set(JSON.stringify(origin), origin)
    }
    for (const preview of event.inputs) {
      const fromResponse = preview.length >= MIN_USE_LENGTH
        ? responseUse(preview, producers)
        : null
      if (fromResponse) {
        add(fromResponse)
        continue
      }
      // Not produced by any response, earlier or later: it may be what the person typed.
      if (!looksTyped(preview) || foundInResponses(preview, everyResponse))
        continue
      const field = typedInputField({
        preview,
        event,
        events: sessionById.get(sessionId)?.events ?? [],
        requestTraces: tracesByExchange.get(consumer.id) ?? [],
        inputKey,
      })
      if (field !== null)
        add({ kind: 'user-input', field })
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
      // Algorithm parameters can carry bytes (an IV, a label); redact them like any value.
      details: event.details === null
        ? null
        : Object.fromEntries(Object.entries(event.details).map(([name, value]) => [
            name,
            redactor.value(value, { in: 'text', name }),
          ])),
      uses: usesOf(event, sessionId, exchange, inputKey),
      evidence: 'transform-hook',
    })
    return { kind: 'computed', computedId: id }
  }

  const originOf = (trace: ValueTrace, exchange: Exchange, operation: Operation, flowId: string): ValueOrigin => {
    const origin = trace.origin
    // A vendor token or a value read from a challenge page is the bot-protection script's to
    // produce (decision 0008): no extraction recipe, pattern or constant for it.
    const vendor = botProtectionInput(trace.location)
      ?? (origin.kind === 'response' && exchangeById.get(origin.exchangeId)?.kind === 'bot-protection'
        ? 'read from a bot-protection step'
        : null)
    if (vendor !== null)
      return { kind: 'browser', note: vendor }
    switch (origin.kind) {
      case 'response':
        return responseOrigin(origin.exchangeId, origin.location, origin.transform, trace.value, flowId)
      case 'transform':
        return computedOrigin(trace, exchange, operation, safeText(formatLocation(trace.location)), origin.eventIndex, origin.sessionId)
      case 'user-input':
        return { kind: 'user-input', field: origin.field }
      case 'constant':
        // Identical in every session can also mean "the same person captured twice": their
        // email or user id. Keep the value only when the redactor would write it unchanged.
        return redactor.value(trace.value, redactContextOf(trace.location)) === trace.value
          ? { kind: 'constant', value: trace.value }
          : {
              kind: 'unknown',
              shape: describeShape(trace.value),
            }
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
      const inputs = collectInputs(occurrences, draftStep.operation, tracesByExchange, (trace, exchange) => originOf(trace, exchange, draftStep.operation, draft.id), safeText)
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
        uniqueName(safeText(outputName(location)), names),
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
    }).map(entry => ({
      ...entry,
      // Evidence quotes request paths (`request to host/path`), which can hold tokens.
      botProtection: entry.botProtection.map(finding => ({
        ...finding,
        evidence: safeText(finding.evidence),
      })),
    })),
    flows,
    computedValues: [
      ...computed.values(),
    ],
  }
}
