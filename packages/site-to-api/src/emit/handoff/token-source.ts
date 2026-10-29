/**
 * Where a host's bearer token comes from, read from the flows: the step whose response the
 * `Authorization` header was traced to. A token endpoint called with nothing the person typed
 * (Spotify's `GET /api/token`) hands out an anonymous token; one fed a typed field is a login.
 */
import type { Analysis, Flow, FlowStep } from '../../model'
import type { StepResolver } from '../steps'
import { createStepResolver } from '../steps'

/** The operation that hands out a host's bearer token, and whether it needs a login. */
export interface TokenSource {
  operationId: string
  /** True when no input of the token step was typed by the person. */
  anonymous: boolean
}

const AUTHORIZATION_INPUT = 'header.authorization'

/** The step a reference names: `s2` within `flow`, or `<flowId>.<stepId>` in another flow. */
function stepOf(reference: string, flow: Flow, analysis: Analysis): FlowStep | null {
  const dot = reference.lastIndexOf('.')
  const owner = dot === -1
    ? flow
    : analysis.flows.flows.find(candidate => candidate.id === reference.slice(0, dot))
  const stepId = dot === -1
    ? reference
    : reference.slice(dot + 1)
  return owner?.steps.find(step => step.id === stepId) ?? null
}

/**
 * The token source of every host whose steps send a traced `Authorization` header. When several
 * operations produce a host's tokens, the one most steps use wins, then the first by name, and
 * the token counts as anonymous only when every producing step is.
 */
export function tokenSources(analysis: Analysis, resolver: StepResolver = createStepResolver(analysis.operations, analysis.flows)): Map<string, TokenSource> {
  const counts = new Map<string, Map<string, { uses: number, anonymous: boolean }>>()
  for (const flow of analysis.flows.flows) {
    for (const step of flow.steps) {
      const origin = step.inputs[AUTHORIZATION_INPUT]
      const host = resolver.operation(step)?.host
      if (origin?.kind !== 'step' || host === undefined)
        continue
      const producer = stepOf(origin.step, flow, analysis)
      if (producer === null)
        continue
      const anonymous = !Object.values(producer.inputs).some(input => input.kind === 'user-input')
      const byOperation = counts.get(host) ?? new Map<string, { uses: number, anonymous: boolean }>()
      const known = byOperation.get(producer.operationId)
      byOperation.set(producer.operationId, {
        uses: (known?.uses ?? 0) + 1,
        anonymous: (known?.anonymous ?? true) && anonymous,
      })
      counts.set(host, byOperation)
    }
  }
  const sources = new Map<string, TokenSource>()
  for (const [host, byOperation] of counts) {
    const [best] = [...byOperation].sort(([a, x], [b, y]) => y.uses - x.uses || a.localeCompare(b))
    if (best)
      sources.set(host, { operationId: best[0], anonymous: best[1].anonymous })
  }
  return sources
}
