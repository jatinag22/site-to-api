/**
 * Values the page computes in the browser before sending them (decision 0017): one line each,
 * naming the function to port. Used by `AGENT.md` (the first few) and `hosts/<host>.md` (all of
 * the host's). Inputs and API names come from the captured site and are escaped.
 */
import type { Analysis, ComputedValue, ValueOrigin } from '../../model'
import type { StepResolver } from '../steps'
import { code, text } from '../escape'
import { computedTier } from './importance'
import { operationName } from './session'
import { describeSource } from './source-ref'

/** Operation of a step reference: `s2` within a flow, or `<flowId>.<stepId>` across flows. */
function operationOfStep(reference: string, analysis: Analysis, resolver: StepResolver): string | null {
  const dot = reference.lastIndexOf('.')
  const flowId = dot === -1
    ? null
    : reference.slice(0, dot)
  const stepId = dot === -1
    ? reference
    : reference.slice(dot + 1)
  for (const flow of analysis.flows.flows) {
    if (flowId !== null && flow.id !== flowId)
      continue
    const step = flow.steps.find(candidate => candidate.id === stepId)
    if (step)
      return operationName(step.operationId, resolver.operation(step)?.host ?? null, resolver)
  }
  return null
}

/** `the value at body./publicKey of getApiAuthKey`, or null when the origin says nothing useful. */
function describeUse(origin: ValueOrigin, analysis: Analysis, resolver: StepResolver): string | null {
  if (origin.kind === 'step') {
    const operation = operationOfStep(origin.step, analysis, resolver)
    return operation
      ? `${code(origin.output)} from ${operation}`
      : null
  }
  if (origin.kind === 'html') {
    const operation = operationOfStep(origin.step, analysis, resolver)
    return operation
      ? `a value from the HTML of ${operation}`
      : null
  }
  return origin.kind === 'user-input'
    ? `the ${code(origin.field)} field`
    : null
}

/** The sentence above the list: what to do with these values. */
export function computedIntro(hasSource: boolean): string {
  return hasSource
    ? 'The wrapper must reproduce these. Port the function named here; the excerpt is in `source/`.'
    : 'The wrapper must reproduce these. Port the function named here.'
}

/** Where and how a value is computed, and what it uses, as Markdown. */
function parts(value: ComputedValue, analysis: Analysis, resolver: StepResolver): { method: string, uses: string[] } {
  const where = value.producedBy
    ? code(describeSource(value.producedBy))
    : 'location not found'
  const how = value.api
    ? ` using ${code(value.api)}${value.details
      ? ` (${text(Object.entries(value.details).map(([key, detail]) => `${key}=${detail}`).join(', '))})`
      : ''}`
    : ''
  return {
    method: `${where}${how}`,
    uses: value.uses.map(origin => describeUse(origin, analysis, resolver)).filter(use => use !== null),
  }
}

/** One list item for a computed value. */
export function computedLine(value: ComputedValue, analysis: Analysis, resolver: StepResolver): string {
  const { method, uses } = parts(value, analysis, resolver)
  const using = uses.length > 0
    ? `; it uses ${uses.join(', ')}`
    : ''
  return `- ${code(value.input)} of ${operationName(value.operationId, resolver.computedHost(value), resolver)}: ${method}${using}.`
}

/** Operations named in a grouped line before "and N more". */
const MAX_GROUPED = 3

/**
 * Computed values that set the same input with the same function, in the order of their first
 * value: Binance computes `header.device-info` with one `btoa` call for 54 operations, which is
 * one function to port.
 */
export function groupComputedValues(values: readonly ComputedValue[], analysis: Analysis, resolver: StepResolver): ComputedValue[][] {
  const groups = new Map<string, ComputedValue[]>()
  for (const value of values) {
    const key = `${value.input}\u0000${parts(value, analysis, resolver).method}`
    groups.set(key, [
      ...(groups.get(key) ?? []),
      value,
    ])
  }
  return [
    ...groups.values(),
  ]
}

/**
 * One list item for a group from {@link groupComputedValues}; a group of one is
 * {@link computedLine}. `more` says where the operations left out are listed.
 */
export function groupedComputedLine(group: readonly ComputedValue[], analysis: Analysis, resolver: StepResolver, more: string): string {
  const [first, ...others] = group
  if (first === undefined)
    return ''
  if (others.length === 0)
    return computedLine(first, analysis, resolver)
  const { method } = parts(first, analysis, resolver)
  const uses = [
    ...new Set(group.flatMap(value => parts(value, analysis, resolver).uses)),
  ]
  const operations = group.map(value => operationName(value.operationId, resolver.computedHost(value), resolver))
  const shown = operations.slice(0, MAX_GROUPED).join(', ')
  const named = operations.length > MAX_GROUPED
    ? `${shown} and ${operations.length - MAX_GROUPED} more in ${more}`
    : shown
  const using = uses.length > 0
    ? `; they use ${uses.slice(0, MAX_GROUPED).join(', ')}${uses.length > MAX_GROUPED
      ? ` and ${uses.length - MAX_GROUPED} more`
      : ''}`
    : ''
  return `- ${code(first.input)} of ${group.length} operations (${named}): ${method}${using}.`
}

const EVIDENCE_ORDER: Record<ComputedValue['evidence'], number> = {
  'transform-hook': 0,
  'source-trace': 1,
  'stack-only': 2,
}

/**
 * Computed values, most useful first: those feeding login, token and session calls, then the
 * site's own API, then telemetry and analytics (see {@link computedTier}); within a tier the most
 * certain first, a hooked crypto call before a traced source line before a bare stack. Stable, so
 * values of equal rank keep the order of `flows.json`.
 */
export function rankedComputedValues(values: readonly ComputedValue[], analysis: Analysis, resolver: StepResolver): ComputedValue[] {
  return values
    .map((value, index) => ({
      value,
      index,
      tier: computedTier(value, analysis, resolver),
    }))
    .sort((a, b) => a.tier - b.tier || EVIDENCE_ORDER[a.value.evidence] - EVIDENCE_ORDER[b.value.evidence] || a.index - b.index)
    .map(({ value }) => value)
}
