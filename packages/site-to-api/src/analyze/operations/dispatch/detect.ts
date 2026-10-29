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

/**
 * Parameter names that are nearly always a dispatcher when their values look like functions.
 * Their values may also be upper-case codes (`cmd=GET_QUOTE`, `action=LIST`).
 */
const STRONG_CANDIDATES: ReadonlySet<string> = new Set([
  'functionName',
  'function',
  'fn',
  'action',
  'wc-ajax',
  'method',
  'op',
  'operation',
  'cmd',
  'command',
].map(name => name.toLowerCase()))

/** Names that also serve as filters or routes: their values must look like function names. */
const WEAK_CANDIDATES: ReadonlySet<string> = new Set([
  'act',
  'api',
  'call',
  'do',
  'route',
  'service',
  'task',
  'type',
])

function isCandidate(name: string): boolean {
  const lower = name.toLowerCase()
  return STRONG_CANDIDATES.has(lower) || WEAK_CANDIDATES.has(lower)
}

/**
 * camelCase, snake_case, dotted, hyphenated or namespaced names starting with a letter:
 * `getSymbolData`, `wc_get_cart`, `system.listMethods`, `load-more`, `user/get`, `user:get`.
 * Numbers, ids and free text do not match.
 */
const FUNCTION_NAME = /^[a-z_]\w*(?:[./:-][a-z_]\w*)*$/i
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

/** Share of an endpoint's requests that must send the parameter; the others stay a plain operation. */
const MIN_CARRIED_SHARE = 0.8
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
  /** Requests of the endpoint that did not send the parameter, in capture order. */
  rest: Exchange[]
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

function looksLikeFunctionName(value: string, parameter: string): boolean {
  return value.length <= MAX_NAME
    && FUNCTION_NAME.test(value)
    && !DIGIT_RUN.test(value)
    && (STRONG_CANDIDATES.has(parameter.toLowerCase()) || !UPPER_WORD.test(value))
    && !HEX_ID.test(value)
    && !NOT_FUNCTIONS.has(value.toLowerCase())
}

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

/** The names one request of a function sends besides the dispatcher, JSON-RPC `params` included. */
function requestNames(exchange: Exchange, parameter: string, location: Location): string[] {
  return [
    ...otherNames(exchange, parameter, location),
    ...(isMethod(parameter) && location === 'json'
      ? jsonRpcParams(exchange)
      : []),
  ]
}

/**
 * The names every request of a function sent (required), and every name any of them sent. One
 * request shows no required names: everything it sent may be optional.
 */
function parameterSets(exchanges: readonly Exchange[], parameter: string, location: Location): Pick<ValueFacts, 'required' | 'sent'> {
  const lists = exchanges.map(exchange => new Set(requestNames(exchange, parameter, location)))
  const sent = new Set(lists.flatMap(list => [...list]))
  const required = lists.length < 2
    ? new Set<string>()
    : new Set([...sent].filter(name => lists.every(list => list.has(name))))
  return { required, sent }
}

interface ValueFacts {
  value: string
  exchanges: Exchange[]
  /** Names every request of the function sent (none when there is only one request). */
  required: Set<string>
  /** Names any request of the function sent. */
  sent: Set<string>
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
    ...parameterSets(exchanges, parameter, location),
    structure,
  }
}

/**
 * One function requires a parameter the other never sent. Optional parameters (`page`, `q` on a
 * search) say nothing: a filter's values send them too.
 */
function differentRequired(a: ValueFacts, b: ValueFacts): boolean {
  return [...a.required].some(name => !b.sent.has(name)) || [...b.required].some(name => !a.sent.has(name))
}

/** Two readable responses that do not come from one template. Unknown responses never differ. */
function unlikeResponses(a: ValueFacts, b: ValueFacts): boolean {
  return a.structure !== null && b.structure !== null && !alike(a.structure, b.structure)
}

/** The response is a JSON-RPC envelope: `result` or `error` at the top level. */
function rpcResponse(exchange: Exchange): boolean {
  const json = exchange.response.body?.json
  return isRecord(json) && ('result' in json || 'error' in json)
}

/**
 * JSON-RPC: a JSON body with `jsonrpc` (2.0), or, for 1.0 without the version field, `id` and
 * `params` with a `result`/`error` response. A body with an `id` and a `method` alone is a
 * payment, a resource or a form, not a call.
 */
function jsonRpcKind(exchanges: readonly Exchange[], location: Location): 'versioned' | 'enveloped' | null {
  if (location !== 'json')
    return null
  const bodies = exchanges.map(jsonObject)
  if (bodies.every(body => body !== null && 'jsonrpc' in body))
    return 'versioned'
  const enveloped = exchanges.every((exchange, index) => {
    const body = bodies[index]
    return body !== null && body !== undefined && 'id' in body && 'params' in body && rpcResponse(exchange)
  })
  return enveloped
    ? 'enveloped'
    : null
}

function pairs<T>(items: readonly T[]): Array<[T, T]> {
  return items.flatMap((a, index) => items.slice(index + 1).map(b => [a, b] as [T, T]))
}

/**
 * Whether the values of one candidate parameter pick functions, on the evidence: a required
 * parameter one function has and the other never sent, or unlike responses. Versioned JSON-RPC
 * needs nothing more: its `method` names the procedure by definition.
 */
function isDispatcher(facts: readonly ValueFacts[], parameter: string, rpc: ReturnType<typeof jsonRpcKind>): boolean {
  if (rpc === 'versioned')
    return true
  const all = pairs(facts)
  if (parameter.toLowerCase() === 'type')
    return facts.length >= MIN_TYPE_VALUES && all.every(([a, b]) => unlikeResponses(a, b))
  const differing = all.filter(([a, b]) => differentRequired(a, b) || unlikeResponses(a, b))
  return differing.length > 0 && differing.length >= all.length * MIN_DIFFERING_SHARE
}

/** Requests that send `parameter` at `location`, and the others; a sent value must be a function name. */
function carriers(exchanges: readonly Exchange[], location: Location, parameter: string): { byValue: Map<string, Exchange[]>, rest: Exchange[] } | null {
  const byValue = new Map<string, Exchange[]>()
  const rest: Exchange[] = []
  for (const exchange of exchanges) {
    if (!namesAt(exchange, location).includes(parameter)) {
      rest.push(exchange)
      continue
    }
    const value = valueAt(exchange, location, parameter)
    if (value === null || !looksLikeFunctionName(value, parameter))
      return null
    byValue.set(value, [
      ...(byValue.get(value) ?? []),
      exchange,
    ])
  }
  return { byValue, rest }
}

function candidateAt(exchanges: readonly Exchange[], location: Location, parameter: string): Dispatcher | null {
  const found = carriers(exchanges, location, parameter)
  if (!found || found.byValue.size < 2)
    return null
  const carried = [
    ...found.byValue.values(),
  ].flat()
  if (carried.length < exchanges.length * MIN_CARRIED_SHARE)
    return null
  const rpc = isMethod(parameter)
    ? jsonRpcKind(carried, location)
    : null
  if (isMethod(parameter) && rpc === null)
    return null
  const facts = [...found.byValue]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, members]) => factsOf(value, members, parameter, location))
  if (!isDispatcher(facts, parameter, rpc))
    return null
  return {
    parameter,
    in: location,
    groups: facts.map(({ value, exchanges: members }) => ({ value, exchanges: members })),
    rest: found.rest,
  }
}

/**
 * Finds the dispatcher parameter of one endpoint (the exchanges of one host + method + path
 * template), or null when there is none. At least 80% of the exchanges must send the parameter
 * once, as a function-like name, at the same place (the others are returned as `rest`): the
 * query string first, then a form field, then a top-level JSON field. Candidates are tried in that order and by name, so the result is the
 * same for the same capture.
 */
export function detectDispatcher(exchanges: readonly Exchange[]): Dispatcher | null {
  if (exchanges.length < 2 || exchanges.some(exchange => exchange.graphql !== undefined || exchange.resourceType === 'websocket'))
    return null
  for (const location of ['query', 'form', 'json'] as const) {
    const names = [
      ...new Set(exchanges.flatMap(exchange => namesAt(exchange, location))),
    ]
      .filter(isCandidate)
      .sort()
    for (const name of names) {
      const found = candidateAt(exchanges, location, name)
      if (found)
        return found
    }
  }
  return null
}
