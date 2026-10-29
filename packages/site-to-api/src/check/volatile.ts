/**
 * Inputs of a request that go stale: a value the page computes in the browser, or a one-time or
 * time-based code (a TOTP, an epoch timestamp). Replaying the captured value later is refused by
 * the site, which says nothing about the API, so such an operation cannot be called drifted
 * (decision 0044).
 */
import type { Analysis, ValueOrigin } from '../model'

/** Shapes (from `describeShape`) of a 6 or 8 digit one-time code, and of an epoch in seconds or milliseconds. */
const TIME_SHAPE = /^(?:6|8|10|13)-digit number$/

function isVolatile(origin: ValueOrigin): boolean {
  return origin.kind === 'computed' || (origin.kind === 'unknown' && TIME_SHAPE.test(origin.shape))
}

/** Per operation id, the sorted names of its inputs that go stale (`query.totp`); operations without any are absent. */
export function volatileInputs(analysis: Analysis): Map<string, string[]> {
  const found = new Map<string, Set<string>>()
  for (const flow of analysis.flows.flows) {
    for (const step of flow.steps) {
      for (const [input, origin] of Object.entries(step.inputs)) {
        if (isVolatile(origin))
          found.set(step.operationId, (found.get(step.operationId) ?? new Set()).add(input))
      }
    }
  }
  return new Map([...found].map(([id, names]) => [
    id,
    [...names].sort(),
  ]))
}
