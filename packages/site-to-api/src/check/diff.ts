/**
 * Compares a live JSON value with an operation's response schema and lists what drifted. Pure:
 * only field paths come out, never values (decision 0044).
 *
 * It judges the way a wrapper would see it. The client's Zod schemas are generated from this
 * same schema, so a missing required field, a changed type or a value outside an enum is what a
 * wrapper's validation rejects. A field the schema does not list is not a failure there (Zod
 * strips it), but it is how a site announces a change, so it is reported as added.
 */
import type { JsonSchema, JsonSchemaType } from '../model'
import type { TypeChange } from '../model/check'

export interface SchemaDiff {
  added: string[]
  removed: string[]
  typeChanged: TypeChange[]
}

/** Elements of one array that are inspected; the rest are assumed to look like these. */
const MAX_ITEMS = 500

type ActualType = JsonSchemaType

function actualType(value: unknown): ActualType {
  if (value === null)
    return 'null'
  if (Array.isArray(value))
    return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'number':
      return Number.isInteger(value)
        ? 'integer'
        : 'number'
    default:
      return 'object'
  }
}

function allowedTypes(schema: JsonSchema): JsonSchemaType[] | null {
  if (schema.type === undefined)
    return null
  return Array.isArray(schema.type)
    ? schema.type
    : [schema.type]
}

function typeAllowed(allowed: JsonSchemaType[], actual: ActualType): boolean {
  return allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'))
}

function emptyDiff(): SchemaDiff {
  return { added: [], removed: [], typeChanged: [] }
}

function size(diff: SchemaDiff): number {
  return diff.added.length + diff.removed.length + diff.typeChanged.length
}

function merge(into: SchemaDiff, from: SchemaDiff): void {
  into.added.push(...from.added)
  into.removed.push(...from.removed)
  into.typeChanged.push(...from.typeChanged)
}

function enumContains(values: ReadonlyArray<string | number | boolean | null>, value: unknown): boolean {
  return new Set<unknown>(values).has(value)
}

/** The anyOf branch that fits best: zero differences, else the fewest among branches of the right type. */
function walkUnion(branches: JsonSchema[], value: unknown, path: string): SchemaDiff {
  const actual = actualType(value)
  const sameType = branches.filter((branch) => {
    const allowed = allowedTypes(branch)
    return allowed === null || typeAllowed(allowed, actual)
  })
  let best: SchemaDiff | null = null
  for (const branch of sameType.length > 0
    ? sameType
    : branches) {
    const diff = walk(branch, value, path)
    if (size(diff) === 0)
      return diff
    if (best === null || size(diff) < size(best))
      best = diff
  }
  return best ?? emptyDiff()
}

/** A value the schema fixes (`const`, `enum`) and the live one is outside it. */
function outsideEnum(schema: JsonSchema, value: unknown): boolean {
  return (schema.const !== undefined && value !== schema.const)
    || (schema.enum !== undefined && !enumContains(schema.enum, value))
}

function walk(schema: JsonSchema, value: unknown, path: string): SchemaDiff {
  if (schema.anyOf && schema.anyOf.length > 0)
    return walkUnion(schema.anyOf, value, path)

  const diff = emptyDiff()
  const allowed = allowedTypes(schema)
  const actual = actualType(value)
  if (allowed !== null && !typeAllowed(allowed, actual)) {
    diff.typeChanged.push({
      path,
      expected: allowed.join(' | '),
      actual,
    })
  }
  else if (outsideEnum(schema, value)) {
    diff.typeChanged.push({ path, expected: 'enum', actual: 'value outside the enum' })
  }
  else if (Array.isArray(value)) {
    const items = schema.items
    if (items)
      value.slice(0, MAX_ITEMS).forEach(item => merge(diff, walk(items, item, `${path}[]`)))
  }
  else if (value !== null && typeof value === 'object') {
    merge(diff, walkObject(schema, value, path))
  }
  return diff
}

function walkObject(schema: JsonSchema, value: object, path: string): SchemaDiff {
  const diff = emptyDiff()
  const live = new Map(Object.entries(value))
  const properties = schema.properties ?? {}
  for (const name of schema.required ?? []) {
    if (!live.has(name))
      diff.removed.push(`${path}.${name}`)
  }
  const extra = schema.additionalProperties
  for (const [name, child] of live) {
    const known = Object.hasOwn(properties, name)
      ? properties[name]
      : undefined
    if (known) {
      merge(diff, walk(known, child, `${path}.${name}`))
    }
    else if (typeof extra === 'object') {
      // A map (decision 0042): its keys are data, so they are never listed.
      merge(diff, walk(extra, child, `${path}.*`))
    }
    else if (extra !== true && schema.properties !== undefined) {
      diff.added.push(`${path}.${name}`)
    }
  }
  return diff
}

function unique(items: string[]): string[] {
  return [
    ...new Set(items),
  ].sort()
}

/**
 * What differs between `schema` and a live JSON `value`. Paths use `$` for the body, `.name` for
 * a field, `[]` for any array element and `.*` for any value of a map. Each list is sorted and
 * free of duplicates, so the same drift always reads the same.
 */
export function diffAgainstSchema(schema: JsonSchema, value: unknown): SchemaDiff {
  const diff = walk(schema, value, '$')
  const seen = new Set<string>()
  const typeChanged = diff.typeChanged
    .filter((change) => {
      const key = `${change.path}\0${change.expected}\0${change.actual}`
      if (seen.has(key))
        return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.actual.localeCompare(b.actual))
  return {
    added: unique(diff.added),
    removed: unique(diff.removed),
    typeChanged,
  }
}
