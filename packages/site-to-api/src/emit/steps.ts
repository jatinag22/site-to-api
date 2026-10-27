/**
 * Which operation a flow step calls. Operation ids are unique per host only and `flows.json`
 * steps carry no host, so `www.site.com` and `api.site.com` can both have `getRoot`. A step's
 * `observedIn` exchange ids say which one it is: the step belongs to the operation whose
 * `exchanges` contain them.
 */
import type { ComputedValue, FlowsDocument, FlowStep, Operation } from '../model'

/** Key for lookups by host and operation id, which together identify an operation. */
export function operationKey(host: string, operationId: string): string {
  return `${host} ${operationId}`
}

/** Finds the operation of a flow step or computed value, by host and operation id. */
export interface StepResolver {
  /** The operation the step calls; `null` when no operation matches or the host is ambiguous. */
  operation: (step: FlowStep) => Operation | null
  /** The host of the step that sends a computed value, found through the steps that use it. */
  computedHost: (value: ComputedValue) => string | null
  /** True when more than one host has an operation with this id. */
  ambiguous: (operationId: string) => boolean
}

function groupBy<T>(items: Iterable<T>, keys: (item: T) => string[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    for (const key of keys(item)) {
      groups.set(key, [
        ...(groups.get(key) ?? []),
        item,
      ])
    }
  }
  return groups
}

/** The only element, or `null` when there are none or several. */
function single<T>(items: readonly T[] | undefined): T | null {
  return items?.length === 1
    ? items[0] ?? null
    : null
}

/**
 * Host of every computed value, from the steps that send it. A value used on two hosts cannot be
 * attributed to either, so it maps to `null`.
 */
function computedHosts(flows: FlowsDocument, operationOf: (step: FlowStep) => Operation | null): Map<string, string | null> {
  const hosts = new Map<string, string | null>()
  for (const step of flows.flows.flatMap(flow => flow.steps)) {
    const host = operationOf(step)?.host ?? null
    for (const origin of Object.values(step.inputs)) {
      if (origin.kind !== 'computed')
        continue
      const known = hosts.get(origin.computedId)
      hosts.set(origin.computedId, known === undefined || known === host
        ? host
        : null)
    }
  }
  return hosts
}

/**
 * Builds a {@link StepResolver}. A step whose exchanges match no operation (a hand-edited
 * `flows.json`, a test fixture) falls back to the operation id alone when exactly one host has
 * it; when several do, it is left unresolved rather than given another host's details.
 */
export function createStepResolver(operations: readonly Operation[], flows: FlowsDocument): StepResolver {
  const byExchange = groupBy(operations, operation => operation.exchanges.map(exchange => exchange.id))
  const byId = groupBy(operations, operation => [operation.operationId])

  const operation = (step: FlowStep): Operation | null => {
    for (const exchangeId of [...step.observedIn].sort()) {
      const match = byExchange.get(exchangeId)?.find(candidate => candidate.operationId === step.operationId)
      if (match)
        return match
    }
    return single(byId.get(step.operationId))
  }
  const hosts = computedHosts(flows, operation)

  return {
    operation,
    computedHost: value => hosts.get(value.id) ?? single(byId.get(value.operationId))?.host ?? null,
    ambiguous: operationId => new Set((byId.get(operationId) ?? []).map(candidate => candidate.host)).size > 1,
  }
}
