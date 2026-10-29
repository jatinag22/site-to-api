/**
 * Dispatcher endpoints (decision 0039): one URL where a parameter picks the function, such as
 * NSE's `GetQuoteApi?functionName=getSymbolData`, WordPress `admin-ajax.php` with `action=` or
 * JSON-RPC's `method`. Detection is by evidence, never by the parameter name alone: the values
 * must look like function names and different values must send different parameters or get
 * differently shaped responses.
 */
import type { DispatchOperation, Exchange } from '../../../model'
import type { Structure } from '../siblings'
import { alike, structureOf } from '../siblings'

type Location = DispatchOperation['in']

/** Parameter names that pick a function. `method` and `type` need more evidence (see below). */
const CANDIDATES: ReadonlySet<string> = new Set([
  'functionName',
  'function',
  'fn',
  'action',
  'method',
  'op',
  'operation',
  'cmd',
  'command',
  'type',
  'api',
  'service',
].map(name => name.toLowerCase()))

/**
 * camelCase, snake_case, dotted or hyphenated names starting with a letter: `getSymbolData`,
 * `wc_get_cart`, `system.listMethods`, `load-more`. Numbers, ids and free text do not match.
 */
const FUNCTION_NAME = /^[a-z_]\w*(?:[.-][a-z_]\w*)*$/i
const MAX_NAME = 64
/** A run of digits marks an id or a date (`item20240101`, `user_12345`), not a function. */
const DIGIT_RUN = /\d{4}/
/** One upper-case word (`RELIANCE`, `NIFTY`) is a symbol or a code, not a function name. */
const UPPER_WORD = /^[A-Z][A-Z\d]*$/
/** Hex of 8 or more with a digit is an id (`deadbeef12`). */
const HEX_ID = /^(?=.*\d)[0-9a-f]{8,}$/i

/**
 * Values that pick a format, an order or a view, never a function: `type=json`, `cmd=asc`.
 * A parameter with any of these values is not a dispatcher.
 */
const NOT_FUNCTIONS = new Set([
  'asc',
  'atom',
  'csv',
  'desc',
  'html',
  'json',
  'jsonp',
  'pdf',
  'rss',
  'text',
  'txt',
  'xml',
  'yaml',
])

/** Share of value pairs that must differ in parameters or response shape. */
const MIN_DIFFERING_SHARE = 0.5
/** `type` is a common filter name: it needs this many values, every pair with unlike responses. */
const MIN_TYPE_VALUES = 3

/** JSON-RPC envelope fields: shared by every method, so they say nothing about the function. */
const JSON_RPC_ENVELOPE = new Set(['id', 'jsonrpc', 'params'])

/** A detected dispatcher: the parameter and the exchanges of each value, values sorted. */
export interface Dispatcher {
  parameter: string
  in: Location
  groups: Array<{ value: string, exchanges: Exchange[] }>
}

function isMethod(parameter: string): boolean {
  return parameter.toLowerCase() === 'method'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonObject(exchange: Exchange): Record<string, unknown> | null {
  const json = exchange.request.body?.json
  return isRecord(json)
    ? json
    : null
}

/** The names sent at one location: query names, form field names or top-level JSON keys. */
function namesAt(exchange: Exchange, location: Location): string[] {
  switch (location) {
    case 'query':
      return exchange.request.query.map(entry => entry.name)
    case 'form':
      return (exchange.request.body?.form ?? []).map(entry => entry.name)
    case 'json':
      return Object.keys(jsonObject(exchange) ?? {})
  }
}

/** The one string value of `name` at `location`, or null when it is missing, repeated or not text. */
function valueAt(exchange: Exchange, location: Location, name: string): string | null {
  if (location === 'json') {
    const value = jsonObject(exchange)?.[name]
    return typeof value === 'string'
      ? value
      : null
  }
  const entries = location === 'query'
    ? exchange.request.query
    : exchange.request.body?.form ?? []
  const values = entries.filter(entry => entry.name === name).map(entry => entry.value)
  return values.length === 1
    ? values[0]!
    : null
}

function looksLikeFunctionName(value: string): boolean {
  return value.length <= MAX_NAME
    && FUNCTION_NAME.test(value)
    && !DIGIT_RUN.test(value)
    && !UPPER_WORD.test(value)
    && !HEX_ID.test(value)
    && !NOT_FUNCTIONS.has(value.toLowerCase())
}

/**
 * The parameter names a request of one function sends besides the dispatcher: the other names at
 * every location, and for JSON-RPC the keys (or the count) of `params`.
 */
/** The names one request sends besides the dispatcher, as `<location>.<name>`. */
function otherNames(exchange: Exchange, parameter: string, location: Location): string[] {
  const jsonRpc = isMethod(parameter) && location === 'json'
  return (['query', 'form', 'json'] as const).flatMap(where => namesAt(exchange, where)
    .filter(name => !(where === location && name === parameter) && !(jsonRpc && where === 'json' && JSON_RPC_ENVELOPE.has(name)))
    .map(name => `${where}.${name}`))
}

/** For JSON-RPC: the keys of `params`, or its arity when it is a list. */
function jsonRpcParams(exchange: Exchange): string[] {
  const params = jsonObject(exchange)?.params
  if (isRecord(params))
    return Object.keys(params).map(name => `params.${name}`)
  return Array.isArray(params)
    ? [`params[${params.length}]`]
    : []
}

/**
 * The parameter names a request of one function sends besides the dispatcher: the other names at
 * every location, and for JSON-RPC the keys (or the count) of `params`.
 */
function parameterSet(exchanges: readonly Exchange[], parameter: string, location: Location): Set<string> {
  const jsonRpc = isMethod(parameter) && location === 'json'
  return new Set(exchanges.flatMap(exchange => [
    ...otherNames(exchange, parameter, location),
    ...(jsonRpc
      ? jsonRpcParams(exchange)
      : []),
  ]))
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(item => b.has(item))
}

interface ValueFacts {
  value: string
  exchanges: Exchange[]
  parameters: Set<string>
  /** The first readable response's structure, or null when no response could be compared. */
  structure: Structure | null
}

function factsOf(value: string, exchanges: Exchange[], parameter: string, location: Location): ValueFacts {
  let structure: Structure | null = null
  for (const exchange of exchanges) {
    structure = structureOf(exchange)
    if (structure)
      break
  }
  return {
    value,
    exchanges,
    parameters: parameterSet(exchanges, parameter, location),
    structure,
  }
}

/** Two readable responses that do not come from one template. Unknown responses never differ. */
function unlikeResponses(a: ValueFacts, b: ValueFacts): boolean {
  return a.structure !== null && b.structure !== null && !alike(a.structure, b.structure)
}

/** JSON-RPC's `method` is only a dispatcher next to `jsonrpc` or `id` in the same place. */
function isJsonRpc(exchanges: readonly Exchange[], location: Location): boolean {
  return exchanges.every((exchange) => {
    const names = namesAt(exchange, location)
    return names.includes('jsonrpc') || names.includes('id')
  })
}

function pairs<T>(items: readonly T[]): Array<[T, T]> {
  return items.flatMap((a, index) => items.slice(index + 1).map(b => [a, b] as [T, T]))
}

/** Whether the values of one candidate parameter pick functions, on the evidence. */
function isDispatcher(facts: readonly ValueFacts[], parameter: string): boolean {
  const all = pairs(facts)
  if (parameter.toLowerCase() === 'type')
    return facts.length >= MIN_TYPE_VALUES && all.every(([a, b]) => unlikeResponses(a, b))
  const differing = all.filter(([a, b]) => !sameSet(a.parameters, b.parameters) || unlikeResponses(a, b))
  return differing.length > 0 && differing.length >= all.length * MIN_DIFFERING_SHARE
}

function candidateAt(exchanges: readonly Exchange[], location: Location, parameter: string): Dispatcher | null {
  if (isMethod(parameter) && !isJsonRpc(exchanges, location))
    return null
  const byValue = new Map<string, Exchange[]>()
  for (const exchange of exchanges) {
    const value = valueAt(exchange, location, parameter)
    if (value === null || !looksLikeFunctionName(value))
      return null
    byValue.set(value, [
      ...(byValue.get(value) ?? []),
      exchange,
    ])
  }
  if (byValue.size < 2)
    return null
  const facts = [...byValue]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, members]) => factsOf(value, members, parameter, location))
  if (!isDispatcher(facts, parameter))
    return null
  return {
    parameter,
    in: location,
    groups: facts.map(({ value, exchanges: members }) => ({ value, exchanges: members })),
  }
}

/**
 * Finds the dispatcher parameter of one endpoint (the exchanges of one host + method + path
 * template), or null when there is none. Every exchange must send the parameter once, as a
 * function-like name, at the same place: the query string first, then a form field, then a
 * top-level JSON field. Candidates are tried in that order and by name, so the result is the
 * same for the same capture.
 */
export function detectDispatcher(exchanges: readonly Exchange[]): Dispatcher | null {
  if (exchanges.length < 2 || exchanges.some(exchange => exchange.graphql !== undefined || exchange.resourceType === 'websocket'))
    return null
  for (const location of ['query', 'form', 'json'] as const) {
    const names = [
      ...new Set(exchanges.flatMap(exchange => namesAt(exchange, location))),
    ]
      .filter(name => CANDIDATES.has(name.toLowerCase()))
      .sort()
    for (const name of names) {
      const found = candidateAt(exchanges, location, name)
      if (found)
        return found
    }
  }
  return null
}
