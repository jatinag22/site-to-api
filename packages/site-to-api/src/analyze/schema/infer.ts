/**
 * JSON Schema inference merged across samples.
 */
import type { JsonSchema, JsonSchemaType } from '../../model'

/** One observed value and the session it came from (constants need two or more sessions). */
export interface Sample {
  value: unknown
  sessionId: string
}

export interface InferOptions {
  /**
   * Called for each candidate enum value; returning false drops the enum. Lets the caller refuse
   * enums of values the redactor would change (personal data must not leak through `enum`).
   */
  allowEnumValue?: (value: string) => boolean
}

/** Nesting deeper than this becomes an untyped schema. */
export const MAX_SCHEMA_DEPTH = 10
const ENUM_MIN_SAMPLES = 3
const ENUM_MAX_VALUES = 10
const ENUM_MAX_LENGTH = 40

const FORMATS: ReadonlyArray<[string, RegExp]> = [
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/],
  ['date', /^\d{4}-\d{2}-\d{2}$/],
  ['email', /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/],
  ['uri', /^https?:\/\/\S+$/],
]

interface Node {
  /** Samples in which this location held a value (null included). */
  count: number
  types: Set<JsonSchemaType>
  /** Distinct scalar values (JSON-encoded), capped once more than one is known. */
  scalars: Set<string>
  sessions: Set<string>
  hasContainer: boolean
  strings: Map<string, number>
  stringCount: number
  stringOverflow: boolean
  formats: Set<string> | null
  objectCount: number
  properties: Map<string, Node>
  keyCounts: Map<string, number>
  items: Node | null
  tooDeep: boolean
}

function newNode(): Node {
  return {
    count: 0,
    types: new Set(),
    scalars: new Set(),
    sessions: new Set(),
    hasContainer: false,
    strings: new Map(),
    stringCount: 0,
    stringOverflow: false,
    formats: null,
    objectCount: 0,
    properties: new Map(),
    keyCounts: new Map(),
    items: null,
    tooDeep: false,
  }
}

function addString(node: Node, value: string): void {
  node.types.add('string')
  node.stringCount++
  if (!node.stringOverflow) {
    node.strings.set(value, (node.strings.get(value) ?? 0) + 1)
    if (node.strings.size > ENUM_MAX_VALUES)
      node.stringOverflow = true
  }
  const matching = FORMATS.filter(([, regex]) => regex.test(value)).map(([name]) => name)
  node.formats = node.formats === null
    ? new Set(matching)
    : new Set([...node.formats].filter(format => matching.includes(format)))
}

function addScalar(node: Node, value: string | number | boolean | null): void {
  if (node.scalars.size < 2)
    node.scalars.add(JSON.stringify(value))
  if (value === null) {
    node.types.add('null')
  }
  else if (typeof value === 'string') {
    addString(node, value)
  }
  else if (typeof value === 'number') {
    node.types.add(Number.isInteger(value)
      ? 'integer'
      : 'number')
  }
  else {
    node.types.add('boolean')
  }
}

function addObject(node: Node, value: object, sessionId: string, depth: number): void {
  node.types.add('object')
  node.hasContainer = true
  node.objectCount++
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined)
      continue
    node.keyCounts.set(key, (node.keyCounts.get(key) ?? 0) + 1)
    let child = node.properties.get(key)
    if (!child) {
      child = newNode()
      node.properties.set(key, child)
    }
    add(child, item, sessionId, depth + 1)
  }
}

function add(node: Node, value: unknown, sessionId: string, depth: number): void {
  if (value === undefined)
    return
  node.count++
  node.sessions.add(sessionId)
  if (depth > MAX_SCHEMA_DEPTH) {
    node.tooDeep = true
  }
  else if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    addScalar(node, value)
  }
  else if (Array.isArray(value)) {
    node.types.add('array')
    node.hasContainer = true
    node.items ??= newNode()
    for (const item of value)
      add(node.items, item, sessionId, depth + 1)
  }
  else if (typeof value === 'object') {
    addObject(node, value, sessionId, depth)
  }
}

function stringKeywords(node: Node, options: InferOptions): JsonSchema {
  const schema: JsonSchema = {}
  const format = node.formats && FORMATS.map(([name]) => name).find(name => node.formats?.has(name))
  if (format) {
    schema.format = format
    return schema
  }
  const values = [
    ...node.strings.keys(),
  ]
  const enumWorthy = !node.stringOverflow
    && node.stringCount >= ENUM_MIN_SAMPLES
    && values.length >= 2
    && values.length < node.stringCount
    && values.every(value => value.length > 0 && value.length <= ENUM_MAX_LENGTH)
    && values.every(value => options.allowEnumValue?.(value) ?? true)
  if (enumWorthy)
    schema.enum = values.sort()
  return schema
}

function finalize(node: Node, options: InferOptions, totalSessions: number): JsonSchema {
  if (node.tooDeep)
    return { description: 'Not inferred: nested too deep' }
  const types = new Set(node.types)
  if (types.has('integer') && types.has('number'))
    types.delete('integer')
  const order: JsonSchemaType[] = [
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
  ]
  const list = order.filter(type => types.has(type))
  if (list.length === 0)
    return {}

  const containers = list.filter(type => type === 'object' || type === 'array')
  const nonNull = list.filter(type => type !== 'null')
  if (containers.length > 0 && nonNull.length > 1) {
    // Mixed containers and scalars do not fit one `type` keyword with sensible keywords.
    return {
      anyOf: list.map(type => finalizeAs(node, type, options, totalSessions)),
    }
  }
  const schema: JsonSchema = {
    type: list.length === 1
      ? list[0]
      : list,
  }
  Object.assign(schema, ...nonNull.map(type => keywordsFor(node, type, options, totalSessions)))
  if (schema.enum && list.includes('null'))
    schema.enum.push(null)
  if (!node.hasContainer && node.scalars.size === 1 && totalSessions >= 2 && node.sessions.size >= totalSessions)
    schema['x-constant'] = true
  return schema
}

function finalizeAs(node: Node, type: JsonSchemaType, options: InferOptions, totalSessions: number): JsonSchema {
  return {
    type,
    ...keywordsFor(node, type, options, totalSessions),
  }
}

function keywordsFor(node: Node, type: JsonSchemaType, options: InferOptions, totalSessions: number): JsonSchema {
  if (type === 'string')
    return stringKeywords(node, options)
  if (type === 'array') {
    return {
      items: node.items
        ? finalize(node.items, options, totalSessions)
        : {},
    }
  }
  if (type === 'object') {
    const properties: Record<string, JsonSchema> = {}
    for (const [key, child] of node.properties)
      properties[key] = finalize(child, options, totalSessions)
    const required = [...node.keyCounts]
      .filter(([, count]) => count === node.objectCount)
      .map(([key]) => key)
    return required.length > 0
      ? { properties, required }
      : { properties }
  }
  return {}
}

/**
 * Infers one JSON Schema describing every sample: `integer` vs `number`, nullable values as type
 * arrays, `required` for keys present in every object, formats shared by all strings, enums when
 * there is enough evidence (≥ 3 samples, 2-10 distinct short strings, some repeated) and
 * `x-constant` for scalars identical in every sample across two or more sessions.
 */
export function inferSchema(samples: Sample[], options: InferOptions = {}): JsonSchema {
  const root = newNode()
  for (const sample of samples)
    add(root, sample.value, sample.sessionId, 0)
  const totalSessions = new Set(samples.map(sample => sample.sessionId)).size
  return finalize(root, options, totalSessions)
}

const INTEGER = /^-?(?:0|[1-9]\d{0,14})$/
const DECIMAL = /^-?(?:0|[1-9]\d{0,14})\.\d+$/

/**
 * Typed versions of string values (query, form, path): all integers → numbers, all booleans →
 * booleans, otherwise the strings unchanged. Leading zeros (`007`) stay strings: they are ids.
 */
export function coerceStrings(values: string[]): Array<string | number | boolean> {
  if (values.length > 0 && values.every(value => INTEGER.test(value) || DECIMAL.test(value)))
    return values.map(Number)
  if (values.length > 0 && values.every(value => value === 'true' || value === 'false'))
    return values.map(value => value === 'true')
  return values
}

/** {@link inferSchema} over string values after {@link coerceStrings}. */
export function inferStringSchema(samples: Array<{ value: string, sessionId: string }>, options: InferOptions = {}): JsonSchema {
  const coerced = coerceStrings(samples.map(sample => sample.value))
  return inferSchema(samples.map((sample, index) => ({ value: coerced[index], sessionId: sample.sessionId })), options)
}
