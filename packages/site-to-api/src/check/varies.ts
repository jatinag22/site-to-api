/**
 * Whether a drift is one the capture already shows: the captured answers of the operation differ
 * from each other at every drifting path (a field present in some and missing in others, or of
 * different types). Such an answer changes on every request by nature (YouTube's `sw.js_data`),
 * so a live answer that differs there is not drift. Pure; reads field paths and types only.
 */
import type { SchemaDiff } from './diff'
import { withoutXssiPrefix } from '../load'

const NOT_JSON = 'not JSON'
const ABSENT = 'absent'

/** A captured or live body read as JSON, or {@link NOT_JSON}. */
type Read = { json: unknown } | typeof NOT_JSON

/** Reads a body as JSON, the way load does: XSSI prefixes (`)]}'`) are dropped first. */
export function readJsonBody(text: string): Read {
  try {
    return {
      json: JSON.parse(withoutXssiPrefix(text)) as unknown,
    }
  }
  catch {
    return NOT_JSON
  }
}

function typeOf(value: unknown): string {
  if (value === null)
    return 'null'
  if (Array.isArray(value))
    return 'array'
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? 'integer'
      : 'number'
  }
  return typeof value
}

/** Steps of a diff path (`$.items[].price`, `$.*`); null when a step is a key shape (`<14 chars>`) that cannot be followed. */
function stepsOf(path: string): string[] | null {
  if (!path.startsWith('$'))
    return null
  const steps: string[] = []
  const pattern = /\.([^.[\]]+)|\[\]/g
  let consumed = 1
  for (const match of path.slice(1).matchAll(pattern)) {
    if (match.index + 1 !== consumed)
      return null
    consumed += match[0].length
    const name = match[1]
    if (name !== undefined && name.startsWith('<'))
      return null
    steps.push(name ?? '[]')
  }
  return consumed === path.length
    ? steps
    : null
}

/** Every value a path reaches in one body. */
function valuesAt(value: unknown, steps: readonly string[]): unknown[] {
  let current: unknown[] = [value]
  for (const step of steps) {
    current = current.flatMap((item) => {
      if (step === '[]') {
        return Array.isArray(item)
          ? item
          : []
      }
      if (item === null || typeof item !== 'object' || Array.isArray(item))
        return []
      const record: Record<string, unknown> = { ...item }
      if (step === '*')
        return Object.values(record)
      return Object.hasOwn(record, step)
        ? [record[step]]
        : []
    })
  }
  return current
}

/** What one body has at a path: its sorted types, or absent, or not JSON. */
function signature(read: Read, steps: readonly string[]): string {
  if (read === NOT_JSON)
    return NOT_JSON
  const values = valuesAt(read.json, steps)
  if (values.length === 0)
    return ABSENT
  return [
    ...new Set(values.map(typeOf)),
  ].sort().join('|')
}

/** The drifting paths of a diff. */
function driftPaths(diff: SchemaDiff): string[] {
  return [
    ...diff.added,
    ...diff.removed,
    ...diff.typeChanged.map(change => change.path),
  ]
}

/**
 * True when at least two captured bodies exist and they already disagree at every path the
 * live answer drifted on, so the drift is how this answer varies between requests.
 */
export function variesInCapture(captured: readonly string[], diff: SchemaDiff): boolean {
  const paths = driftPaths(diff)
  if (captured.length < 2 || paths.length === 0)
    return false
  const reads = captured.map(readJsonBody)
  return paths.every((path) => {
    const steps = stepsOf(path)
    if (steps === null)
      return false
    return new Set(reads.map(read => signature(read, steps))).size > 1
  })
}
