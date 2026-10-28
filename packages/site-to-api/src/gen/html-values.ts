/**
 * Collects the values `flows.json` says are read from an HTML page (origins of kind `html`, such
 * as a CSRF token in a meta tag) and names one `extract<Input>From<Operation>` reader for each.
 * Pure: flows in, named readers out.
 */
import type { HtmlValueLocation } from '@site-to-api/runtime'
import type { Flow, FlowsDocument, FlowStep } from '../model'
import { toPascalCase } from './spec'

/** A reader for one value of an HTML page, named after the input it feeds. */
export interface NamedHtmlValue {
  functionName: string
  /** Operation whose HTML response holds the value, e.g. `getLogin`. */
  sourceOperationId: string
  /** Request location the value feeds, e.g. `header.x-csrf-token`. */
  input: string
  /** Operations that send the value, sorted. */
  usedBy: string[]
  location: HtmlValueLocation
  confidence: 'high' | 'low'
  /** Other locations seen for the same input and page (e.g. another row of a list), sorted. */
  alternatives: HtmlValueLocation[]
}

interface Candidate {
  input: string
  sourceOperationId: string
  usedBy: string
  location: HtmlValueLocation
  confidence: 'high' | 'low'
}

/**
 * One reader per input name and source page, in `flows.json` order: the first location seen is
 * the one read, later different ones are listed as alternatives. `taken` holds names already in
 * use in `client/extract.ts`; a clash gets a numeric suffix.
 */
export function nameHtmlValues(flows: FlowsDocument, taken: ReadonlySet<string>, warnings: string[]): NamedHtmlValue[] {
  const byName = new Map<string, NamedHtmlValue>()
  for (const candidate of collectCandidates(flows, warnings)) {
    const base = `extract${inputName(candidate.input)}From${operationName(candidate.sourceOperationId)}`
    const existing = byName.get(base)
    if (existing) {
      if (!existing.usedBy.includes(candidate.usedBy))
        existing.usedBy.push(candidate.usedBy)
      if (!sameLocation(existing.location, candidate.location) && !existing.alternatives.some(other => sameLocation(other, candidate.location)))
        existing.alternatives.push(candidate.location)
      continue
    }
    byName.set(base, {
      functionName: base,
      sourceOperationId: candidate.sourceOperationId,
      input: candidate.input,
      usedBy: [candidate.usedBy],
      location: candidate.location,
      confidence: candidate.confidence,
      alternatives: [],
    })
  }

  const used = new Set(taken)
  const named: NamedHtmlValue[] = []
  for (const value of byName.values()) {
    let unique = value.functionName
    for (let n = 2; used.has(unique); n++)
      unique = `${value.functionName}${n}`
    used.add(unique)
    named.push({
      ...value,
      functionName: unique,
      usedBy: value.usedBy.sort(),
      alternatives: value.alternatives.sort((a, b) => locationKey(a).localeCompare(locationKey(b))),
    })
  }
  return named.sort((a, b) => a.functionName.localeCompare(b.functionName))
}

function collectCandidates(flows: FlowsDocument, warnings: string[]): Candidate[] {
  const candidates: Candidate[] = []
  for (const flow of flows.flows) {
    for (const step of flow.steps) {
      for (const [input, origin] of Object.entries(step.inputs).sort(([a], [b]) => a.localeCompare(b))) {
        if (origin.kind !== 'html')
          continue
        const source = resolveStep(flows, flow, origin.step)
        if (!source) {
          warnings.push(`flows.json: ${flow.id}.${step.id} reads ${input} from step ${origin.step}, which does not exist; no HTML reader is generated for it`)
          continue
        }
        candidates.push({
          input,
          sourceOperationId: source.operationId,
          usedBy: step.operationId,
          location: { selector: origin.selector, attr: origin.attr, pattern: origin.pattern },
          confidence: origin.confidence,
        })
      }
    }
  }
  return candidates
}

/** `s1` is a step of the same flow; `<flowId>.<stepId>` names a step of another flow. */
function resolveStep(flows: FlowsDocument, current: Flow, ref: string): FlowStep | null {
  const dot = ref.lastIndexOf('.')
  const flow = dot === -1
    ? current
    : flows.flows.find(candidate => candidate.id === ref.slice(0, dot))
  const stepId = dot === -1
    ? ref
    : ref.slice(dot + 1)
  return flow?.steps.find(step => step.id === stepId) ?? null
}

/**
 * `header.x-csrf-token` → `CsrfToken`, `cookie.pm_store` → `PmStore`, `body./user/id` → `Id`.
 * The `x-` of custom headers says nothing about the value, so it is dropped.
 */
function inputName(input: string): string {
  const dot = input.indexOf('.')
  const where = dot === -1
    ? ''
    : input.slice(0, dot)
  let name = dot === -1
    ? input
    : input.slice(dot + 1)
  if (where === 'body')
    name = name.split('/').filter(Boolean).at(-1) ?? ''
  if (where === 'header')
    name = name.replace(/^x-/i, '')
  return safePascal(name, 'Value')
}

function operationName(operationId: string): string {
  return safePascal(operationId, 'Operation')
}

/** PascalCase letters and digits, never empty; a leading digit is fine after `extract…From`. */
function safePascal(value: string, fallback: string): string {
  const pascal = toPascalCase(value)
  return pascal === ''
    ? fallback
    : pascal
}

function locationKey(location: HtmlValueLocation): string {
  return JSON.stringify([location.selector, location.attr, location.pattern])
}

function sameLocation(a: HtmlValueLocation, b: HtmlValueLocation): boolean {
  return locationKey(a) === locationKey(b)
}
