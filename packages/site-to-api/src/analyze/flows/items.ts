/**
 * Response locations that name one of several items rather than the item a sample happened to
 * use: array indexes become `*`, and HTML positions that varied across samples are dropped.
 */
import type { Exchange, Operation, ValueLocation, ValueTrace } from '../../model'
import { anyItemPointer, positionSkeleton, repeatedSelector } from './locations'

type HtmlLocation = Extract<ValueLocation, { in: 'html' }>

/** A response location as outputs should name it; `repeated` when positions were dropped. */
export interface GeneralLocation {
  location: ValueLocation
  repeated: boolean
}

/**
 * Builds the function that generalises producer locations for one build. HTML producers whose
 * samples took a value from different positions of one repeated element (`li:nth-of-type(1)`
 * in one sample, `li:nth-of-type(2)` in another) get the repeated element's selector, grouped by
 * producing operation, attribute and pattern. JSON pointers get `*` for every array index.
 */
export function createLocationGeneralizer(
  traces: readonly ValueTrace[],
  exchangeById: ReadonlyMap<string, Exchange>,
  operationOf: (exchangeId: string) => Operation | undefined,
): (producerId: string, location: ValueLocation) => GeneralLocation {
  const groupKey = (producerId: string, location: HtmlLocation): string | null => {
    const operation = operationOf(producerId)
    if (!operation || location.selector === '')
      return null
    return [
      operation.operationId,
      positionSkeleton(location.selector),
      location.attr ?? '',
      location.pattern ?? '',
    ].join('\u0000')
  }
  const selectorsByGroup = new Map<string, Set<string>>()
  for (const trace of traces) {
    if (trace.origin.kind !== 'response' || trace.origin.location.in !== 'html')
      continue
    const key = groupKey(trace.origin.exchangeId, trace.origin.location)
    if (key !== null)
      selectorsByGroup.set(key, (selectorsByGroup.get(key) ?? new Set()).add(trace.origin.location.selector))
  }
  const repeated = new Map<string, string>()
  for (const [key, selectors] of selectorsByGroup) {
    const selector = selectors.size >= 2
      ? repeatedSelector([...selectors].sort())
      : null
    if (selector !== null)
      repeated.set(key, selector)
  }

  return (producerId, location) => {
    if (location.in === 'body') {
      const json = exchangeById.get(producerId)?.response.body?.json
      return {
        location: {
          ...location,
          pointer: anyItemPointer(json, location.pointer),
        },
        repeated: false,
      }
    }
    if (location.in === 'html') {
      const key = groupKey(producerId, location)
      const selector = key === null
        ? undefined
        : repeated.get(key)
      if (selector !== undefined) {
        return {
          location: { ...location, selector },
          repeated: true,
        }
      }
    }
    return { location, repeated: false }
  }
}
