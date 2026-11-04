/**
 * JSON Schema inference merged across samples.
 */
import type { JsonSchema, JsonSchemaType } from '../../model'
import { z } from 'zod'

/** One observed value and the session it came from (constants need two or more sessions). */
export interface Sample {
  value: unknown
  sessionId: string
  /**
   * Identity of the request this value answers (its redacted path, query and body), for
   * `required: 'distinct-requests'`. Samples without one count as one request.
   */
  request?: string
}

export interface InferOptions {
  /**
   * Called for each candidate enum value with the name of the field holding it; returning false
   * drops the enum. Lets the caller refuse enums of values the redactor would change (personal
   * data must not leak through `enum`, `username: ["demo_90001", …]` included).
   */
  allowEnumValue?: (value: string, name: string | null) => boolean
  /**
   * True when an object, by its name and keys, describes a person (decision 0063). Values in
   * such a record are that person's and never become an enum, whatever their field name.
   */
  isPersonObject?: (name: string | null, keys: readonly string[]) => boolean
  /**
   * Name of the value being inferred (query parameter, header, form field). Object properties
   * use their own key; array items use the array's name. Enums need a code-like name or
   * code-like values, so the name matters.
   */
  name?: string | null
  /**
   * `present` (the default): an object key is required when every sample has it, which is what a
   * response promises. `varies`: it must also take more than one value across the samples, which
   * is the evidence that a request needs the caller to supply it. Algolia sends
   * `analyticsTags: ['web']` in every search, yet a search without it works.
   * `distinct-requests`: present in every object at that level, and those objects answered at
   * least two different requests. A field seen only in answers to the same request may depend on
   * it: IKEA returns `displayLocations` only when `expand` asks for them.
   */
  required?: 'present' | 'varies' | 'distinct-requests'
  /**
   * Called for each object key; returning true makes the key data rather than a field name (a
   * session token, an email). Such keys are never listed: their values merge into one
   * `additionalProperties` schema, so the object reads as a map (decision 0042).
   */
  isMapKey?: (key: string) => boolean
}

/** Nesting deeper than this becomes an untyped schema. */
export const MAX_SCHEMA_DEPTH = 10
const ENUM_MIN_SAMPLES = 3
const ENUM_MAX_VALUES = 10
const ENUM_MAX_LENGTH = 32
/** Each distinct value must be seen this many times on average: a few values, many samples. */
const ENUM_MIN_SAMPLES_PER_VALUE = 2
/**
 * An enum needs values seen in this many browsing sessions (decision 0058). One session shows the
 * few values that visit happened to meet (`category: ["dairy", "snacks"]`), and the generated
 * client then rejected every other category the site has.
 */
const ENUM_MIN_SESSIONS = 2

/** Name words that say a field holds a code from a fixed set rather than free data. */
const CODE_NAME_WORDS: ReadonlySet<string> = new Set([
  'code',
  'codes',
  'status',
  'statuses',
  'state',
  'type',
  'types',
  'kind',
  'kinds',
  'category',
  'categories',
  'currency',
  'currencies',
  'unit',
  'units',
])

/**
 * Name words of identifiers and labels. Their values can look like tokens (`masala-makhana-250-g`)
 * but every new record brings a new one, so token-shaped values alone do not make them enums.
 */
const IDENTITY_NAME_WORDS: ReadonlySet<string> = new Set([
  'id',
  'ids',
  'uuid',
  'slug',
  'slugs',
  'sku',
  'handle',
  'key',
  'ref',
  'name',
  'title',
  'label',
  'description',
])

/** `PAID`, `IN_STOCK`, `out-of-stock`, `credit_card`: tokens a program defines, not prose. */
const CODE_TOKEN = [
  /^[A-Z][A-Z\d]*(?:_[A-Z\d]+)*$/,
  /^[a-z][a-z\d]*(?:-[a-z\d]+)+$/,
  /^[a-z][a-z\d]*(?:_[a-z\d]+)+$/,
]

/** Lower-case words of a field name: `orderStatus` → `[order, status]`, `currency_code` → `[currency, code]`. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word !== '')
}

function isCodeName(name: string | null): boolean {
  return name !== null && nameWords(name).some(word => CODE_NAME_WORDS.has(word))
}

function isIdentityName(name: string | null): boolean {
  return name !== null && nameWords(name).some(word => IDENTITY_NAME_WORDS.has(word))
}

/** A program token (`IN_STOCK`, `out-of-stock`, `order_created`), not free text. */
export function isCodeToken(value: string): boolean {
  return CODE_TOKEN.some(pattern => pattern.test(value))
}

/**
 * Formats and the Zod check the generated client runs for each (hey-api's zod plugin, configured
 * in gen/generate.ts: `date-time` → `z.iso.datetime({ offset: true, local: true })`, `uri` →
 * `z.url()`, ...). A format is a promise the client enforces on live data, so it is inferred only
 * when every sample passes that same check, not just the looser shape test in front of it. The
 * shape test keeps ordinary strings away from the Zod call and keeps `uri` to web addresses.
 */
const FORMATS: ReadonlyArray<[string, RegExp, z.ZodType<string>]> = [
  [
    'uuid',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    z.uuid(),
  ],
  [
    'date-time',
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/,
    z.iso.datetime({ offset: true, local: true }),
  ],
  [
    'date',
    /^\d{4}-\d{2}-\d{2}$/,
    z.iso.date(),
  ],
  [
    'email',
    /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/,
    z.email(),
  ],
  [
    'uri',
    /^https?:\/\/\S+$/,
    z.url(),
  ],
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
  /** Values under keys that are data (`InferOptions.isMapKey`), merged. */
  mapValues: Node | null
  items: Node | null
  tooDeep: boolean
  /** Up to two distinct JSON encodings of the values seen here, kept only for `required: 'varies'`. */
  distinct: Set<string>
  /** Up to two distinct requests whose answers had an object here (`required: 'distinct-requests'`). */
  requests: Set<string>
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
    mapValues: null,
    items: null,
    tooDeep: false,
    distinct: new Set(),
    requests: new Set(),
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
  const candidates = node.formats === null
    ? FORMATS
    : FORMATS.filter(([name]) => node.formats?.has(name))
  const matching = candidates
    .filter(([, regex, check]) => regex.test(value) && check.safeParse(value).success)
    .map(([name]) => name)
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

function addObject(node: Node, value: object, sample: Visit, depth: number): void {
  node.types.add('object')
  if (node.requests.size < 2)
    node.requests.add(sample.request)
  node.hasContainer = true
  node.objectCount++
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined)
      continue
    if (sample.isMapKey(key)) {
      node.mapValues ??= newNode()
      add(node.mapValues, item, sample, depth + 1)
      continue
    }
    node.keyCounts.set(key, (node.keyCounts.get(key) ?? 0) + 1)
    let child = node.properties.get(key)
    if (!child) {
      child = newNode()
      node.properties.set(key, child)
    }
    add(child, item, sample, depth + 1)
  }
}

/** What every node visited for one sample needs to know about it. */
interface Visit {
  sessionId: string
  request: string
  /** Record distinct values (`required: 'varies'`). */
  track: boolean
  isMapKey: (key: string) => boolean
}

function add(node: Node, value: unknown, sample: Visit, depth: number): void {
  if (value === undefined)
    return
  node.count++
  if (sample.track && node.distinct.size < 2)
    node.distinct.add(JSON.stringify(value))
  node.sessions.add(sample.sessionId)
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
      add(node.items, item, sample, depth + 1)
  }
  else if (typeof value === 'object') {
    addObject(node, value, sample, depth)
  }
}

/**
 * Whether the observed strings are a closed set of codes. A wrong enum is worse than none: Zod
 * validation in generated clients rejects every value not seen in the capture. So only short,
 * space-free values qualify, seen repeatedly, and only under a code-like name (`status`,
 * `currency`) or when every value is a program token (`IN_STOCK`, `out-of-stock`) under a name
 * that is not an identifier (`slug`, `id`). Names, titles and other free text never become enums.
 */
function isEnumWorthy(node: Node, values: string[], name: string | null, options: InferOptions, record: boolean): boolean {
  if (record || node.stringOverflow || values.length < 2 || node.sessions.size < ENUM_MIN_SESSIONS)
    return false
  // Values that differ across most samples are data, not a closed set: each distinct value must
  // have been seen at least twice on average.
  if (node.stringCount < ENUM_MIN_SAMPLES || node.stringCount < values.length * ENUM_MIN_SAMPLES_PER_VALUE)
    return false
  if (!values.every(value => value.length > 0 && value.length <= ENUM_MAX_LENGTH && !/\s/.test(value)))
    return false
  // Numbers are open-ended: the next store has another code, the next tick another price. A
  // value that reads as a number (`1234`, `-0.51`, `22749.75`) never makes an enum.
  if (values.some(value => /^[+-]?\d+(?:\.\d+)?$/.test(value)))
    return false
  if (!isCodeName(name) && (isIdentityName(name) || !values.every(isCodeToken)))
    return false
  return values.every(value => options.allowEnumValue?.(value, name) ?? true)
}

function stringKeywords(node: Node, name: string | null, options: InferOptions, record: boolean): JsonSchema {
  const schema: JsonSchema = {}
  const format = node.formats && FORMATS.map(([name]) => name).find(name => node.formats?.has(name))
  if (format) {
    schema.format = format
    return schema
  }
  const values = [
    ...node.strings.keys(),
  ]
  if (isEnumWorthy(node, values, name, options, record))
    schema.enum = values.sort()
  return schema
}

function finalize(node: Node, name: string | null, options: InferOptions, totalSessions: number, record = false): JsonSchema {
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
      anyOf: list.map(type => finalizeAs(node, type, name, options, totalSessions, record)),
    }
  }
  const schema: JsonSchema = {
    type: list.length === 1
      ? list[0]
      : list,
  }
  Object.assign(schema, ...nonNull.map(type => keywordsFor(node, type, name, options, totalSessions, record)))
  // `enum` constrains every value, whatever its type: strings seen next to numbers (a chart row
  // `[1793178059000, 22634.3, "PO", 0]`) would make every number "outside the enum".
  if (nonNull.some(type => type !== 'string'))
    delete schema.enum
  if (schema.enum && list.includes('null'))
    schema.enum.push(null)
  if (!node.hasContainer && node.scalars.size === 1 && totalSessions >= 2 && node.sessions.size >= totalSessions)
    schema['x-constant'] = true
  return schema
}

function finalizeAs(node: Node, type: JsonSchemaType, name: string | null, options: InferOptions, totalSessions: number, record: boolean): JsonSchema {
  return {
    type,
    ...keywordsFor(node, type, name, options, totalSessions, record),
  }
}

function keywordsFor(node: Node, type: JsonSchemaType, name: string | null, options: InferOptions, totalSessions: number, record: boolean): JsonSchema {
  if (type === 'string')
    return stringKeywords(node, name, options, record)
  if (type === 'array') {
    return {
      items: node.items
        ? finalize(node.items, name, options, totalSessions, record)
        : {},
    }
  }
  if (type === 'object') {
    const person = options.isPersonObject?.(name, [
      ...node.properties.keys(),
    ]) ?? false
    // `Object.fromEntries` defines own properties, so a key named `__proto__` stays a key;
    // assigning it would set the prototype and drop it from `properties`.
    const properties: Record<string, JsonSchema> = Object.fromEntries([...node.properties].map(([key, child]) => [
      key,
      finalize(child, key, options, totalSessions, person),
    ]))
    const required = node.requests.size < 2 && options.required === 'distinct-requests'
      ? []
      : [...node.keyCounts]
          .filter(([key, count]) => count === node.objectCount
            && (options.required !== 'varies' || (node.properties.get(key)?.distinct.size ?? 0) > 1))
          .map(([key]) => key)
    const schema: JsonSchema = {}
    // A pure map lists no properties; an empty object still says it has none.
    if (node.properties.size > 0 || node.mapValues === null)
      schema.properties = properties
    if (required.length > 0)
      schema.required = required
    if (node.mapValues !== null)
      schema.additionalProperties = finalize(node.mapValues, name, options, totalSessions, person)
    return schema
  }
  return {}
}

/**
 * Infers one JSON Schema describing every sample: `integer` vs `number`, nullable values as type
 * arrays, `required` for keys present in every object, formats shared by all strings, enums for
 * code-like values only (see `isEnumWorthy`: ≤ 32 characters, no whitespace, 2-10 distinct values
 * each seen twice on average, under a code-like name or all program tokens) and
 * `x-constant` for scalars identical in every sample across two or more sessions. Objects keyed
 * by data (see `InferOptions.isMapKey`) get `additionalProperties` instead of those keys.
 */
export function inferSchema(samples: Sample[], options: InferOptions = {}): JsonSchema {
  const isMapKey = options.isMapKey ?? (() => false)
  const root = newNode()
  for (const sample of samples) {
    add(root, sample.value, {
      sessionId: sample.sessionId,
      request: sample.request ?? '',
      track: options.required === 'varies',
      isMapKey,
    }, 0)
  }
  const totalSessions = new Set(samples.map(sample => sample.sessionId)).size
  return finalize(root, options.name ?? null, options, totalSessions)
}

const INTEGER = /^-?(?:0|[1-9]\d{0,14})$/
const DECIMAL = /^-?(?:0|[1-9]\d{0,14})\.\d+$/

/**
 * Name words of codes written in digits, matched as whole words (singular or plural: `itemNos`,
 * `userIds`, `zip_code`, `phoneNumber`), plus compounds written as one word. `encode` and
 * `decode` are not codes, so `code` is never matched as a suffix.
 */
const DIGIT_CODE_WORDS: ReadonlySet<string> = new Set([
  'id',
  'no',
  'code',
  'sku',
  'number',
  'zip',
  'pin',
  'otp',
  'totp',
  'zipcode',
  'pincode',
  'postcode',
  'barcode',
])
/** Digit strings of one length this long or longer are codes (a TOTP, an item number), not amounts. */
const MIN_CODE_DIGITS = 6
/** Unix time in seconds or milliseconds (2001 to 2033): a moment, not a code. */
const EPOCH = /^1\d{9}(?:\d{3})?$/

function singular(word: string): string {
  return word.endsWith('s') && word.length > 2
    ? word.slice(0, -1)
    : word
}

function isDigitCodeName(name: string | null): boolean {
  if (name === null)
    return false
  const words = nameWords(name).map(singular)
  // `pageNumber`, `pageNo` and `numberOfItems` count things.
  if (words.includes('page') || (words[0] === 'number' && words[1] === 'of'))
    return false
  return words.some(word => DIGIT_CODE_WORDS.has(word))
}

/**
 * Whether integer-looking text is a code that must stay a string: IKEA item numbers and Spotify's
 * `totp` are digits, but typed as `number` they lose leading zeros and invite arithmetic. Codes
 * are values under a code-like name (`itemNos`, `userId`, `zip`), or at least two different digit
 * strings that all have the same length of six or more and are not Unix times. One sample of
 * `amount=250000` says nothing about the length of the next. Leading zeros already keep a value a
 * string.
 */
function isDigitCode(values: string[], name: string | null): boolean {
  if (!values.every(value => INTEGER.test(value)))
    return false
  if (isDigitCodeName(name))
    return true
  if (new Set(values).size < 2 || values.some(value => EPOCH.test(value)))
    return false
  const lengths = new Set(values.map(value => value.replace(/^-/, '').length))
  const [length] = lengths
  return lengths.size === 1 && length !== undefined && length >= MIN_CODE_DIGITS
}

/**
 * Typed versions of string values (query, form, path): all integers → numbers, all booleans →
 * booleans, otherwise the strings unchanged. Leading zeros (`007`) and digit codes (see
 * {@link isDigitCode}; `name` is the parameter or field name) stay strings: they are ids.
 */
export function coerceStrings(values: string[], name: string | null = null): Array<string | number | boolean> {
  if (values.length > 0 && values.every(value => INTEGER.test(value) || DECIMAL.test(value)) && !isDigitCode(values, name))
    return values.map(Number)
  if (values.length > 0 && values.every(value => value === 'true' || value === 'false'))
    return values.map(value => value === 'true')
  return values
}

/** {@link inferSchema} over string values after {@link coerceStrings}. */
export function inferStringSchema(samples: Array<{ value: string, sessionId: string }>, options: InferOptions = {}): JsonSchema {
  const coerced = coerceStrings(samples.map(sample => sample.value), options.name ?? null)
  return inferSchema(samples.map((sample, index) => ({ value: coerced[index], sessionId: sample.sessionId })), options)
}
