/**
 * Fills each operation's query, headers, cookies, request body and responses from its exchanges.
 */
import type { Body, Exchange, HeaderInfo, JsonSchema, NameValue, Operation, ParamInfo, RedactContext, Redactor, RequestBodyInfo, ResponseInfo } from '../../model'
import type { InferOptions } from './infer'
import { pinGraphqlSchemas } from '../graphql'
import { coerceStrings, inferSchema, inferStringSchema } from './infer'

/**
 * Request headers the browser or the HTTP stack sets on its own. A client never needs to send
 * them by hand, so they stay out of the specs. Everything else (referer, origin, `x-*`, accept,
 * user-agent, content-type) is kept.
 */
const BROWSER_MANAGED_HEADERS: readonly string[] = [
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'upgrade',
  'accept-encoding',
  'priority',
  'upgrade-insecure-requests',
  'cookie',
  'sec-fetch-*',
  'sec-ch-*',
]

/** GraphQL fields a query string carries as JSON text (GraphQL over HTTP, GET requests). */
const GRAPHQL_JSON_PARAMS: ReadonlySet<string> = new Set(['variables', 'extensions'])

/** Text request bodies longer than this get no example. */
const MAX_TEXT_EXAMPLE_LENGTH = 2000

export function isBrowserManagedHeader(name: string): boolean {
  return matchesHeaderList(BROWSER_MANAGED_HEADERS, name)
}

function namesInOrder(lists: NameValue[][]): string[] {
  const names = new Set<string>()
  for (const list of lists) {
    for (const item of list)
      names.add(item.name)
  }
  return [...names]
}

/**
 * Headers that describe the capture browser, not the API. Replaying them would make every
 * generated client claim to be the capture's (often headless) Chrome, so they are never
 * constants with a default and never required; their observed values stay as examples.
 */
const BROWSER_IDENTITY_HEADERS: readonly string[] = [
  'user-agent',
  'accept-language',
  'sec-ch-ua*',
]

/** Sessions a value must be identical in before it counts as a constant (decision 0004). */
const MIN_CONSTANT_SESSIONS = 2

function matchesHeaderList(list: readonly string[], name: string): boolean {
  return list.some(entry => entry.endsWith('*')
    ? name.startsWith(entry.slice(0, -1))
    : name === entry)
}

/** True for `user-agent`, `accept-language` and `sec-ch-ua*`: the capture browser's identity. */
function isBrowserIdentityHeader(name: string): boolean {
  return matchesHeaderList(BROWSER_IDENTITY_HEADERS, name.toLowerCase())
}

function enumGuard(redactor: Redactor, context: RedactContext): InferOptions {
  return {
    allowEnumValue: value => redactor.value(value, context) === value,
    name: context.name ?? null,
  }
}

function withExamples(schema: JsonSchema, examples: unknown[]): JsonSchema {
  return examples.length > 0
    ? { ...schema, examples }
    : schema
}

/** Parses JSON object or array text; undefined for anything else. */
function parseJsonText(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
    return undefined
  try {
    return JSON.parse(trimmed) as unknown
  }
  catch {
    return undefined
  }
}

/**
 * A parameter whose every value is JSON text (GraphQL `variables` in a query string): the schema
 * describes the decoded value, so the client can take an object and encode it.
 */
function inferJsonParam(name: string, samples: Array<{ value: string, sessionId: string }>, present: number, total: number, redactor: Redactor): ParamInfo | null {
  const decoded = samples.map(sample => ({
    value: parseJsonText(sample.value),
    sessionId: sample.sessionId,
  }))
  if (decoded.length === 0 || decoded.some(sample => sample.value === undefined))
    return null
  const context: RedactContext = { in: 'query', name }
  return {
    name,
    required: present === total,
    schema: withExamples(inferSchema(decoded, enumGuard(redactor, { in: 'body' })), redactor.examples(decoded.map(sample => sample.value), context)),
    json: true,
  }
}

function inferParams(exchanges: Exchange[], pick: (exchange: Exchange) => NameValue[], where: RedactContext['in'], redactor: Redactor, jsonNames: ReadonlySet<string> = new Set()): ParamInfo[] {
  const lists = exchanges.map(pick)
  return namesInOrder(lists).map((name) => {
    const context: RedactContext = { in: where, name }
    const samples: Array<{ value: string, sessionId: string }> = []
    let repeated = false
    let present = 0
    lists.forEach((list, index) => {
      const values = list.filter(item => item.name === name).map(item => item.value)
      if (values.length === 0)
        return
      present++
      repeated ||= values.length > 1
      for (const value of values)
        samples.push({ value, sessionId: exchanges[index]!.sessionId })
    })
    const json = jsonNames.has(name) && !repeated
      ? inferJsonParam(name, samples, present, exchanges.length, redactor)
      : null
    if (json)
      return json
    const item = inferStringSchema(samples, enumGuard(redactor, context))
    const examples = redactor.examples(coerceStrings(samples.map(sample => sample.value), name), context)
    return {
      name,
      required: present === exchanges.length,
      schema: repeated
        ? { type: 'array', items: item }
        : withExamples(item, examples),
    }
  })
}

/**
 * Tracing headers that monitoring scripts (Sentry, OpenTelemetry, Datadog, Zipkin, New Relic) add to the
 * page's requests. Servers do not need them, so they are never required and never a default: a
 * client that replayed the capture's trace ids would report into someone else's trace.
 */
const TELEMETRY_HEADERS: readonly string[] = [
  'baggage',
  'sentry-trace',
  'traceparent',
  'tracestate',
  'b3',
  'x-b3-*',
  'x-datadog-*',
  'x-newrelic-id',
]

/** True for `baggage`, `sentry-trace`, `traceparent`, `x-datadog-*`, `x-b3-*` and the like. */
export function isTelemetryHeader(name: string): boolean {
  return matchesHeaderList(TELEMETRY_HEADERS, name.toLowerCase())
}

/**
 * Header values that are the same in every request to the host across two or more sessions
 * (`x-requested-with: XMLHttpRequest`, `github-is-react: true`). An operation seen in one session
 * only cannot prove its own constants, but the host's other requests can.
 */
function hostConstantHeaders(exchanges: Exchange[]): Map<string, string> {
  const seen = new Map<string, { values: Set<string>, sessions: Set<string> }>()
  for (const exchange of exchanges) {
    for (const header of exchange.request.headers) {
      const entry = seen.get(header.name) ?? {
        values: new Set<string>(),
        sessions: new Set<string>(),
      }
      entry.values.add(header.value)
      entry.sessions.add(exchange.sessionId)
      seen.set(header.name, entry)
    }
  }
  const constants = new Map<string, string>()
  for (const [name, entry] of seen) {
    const [only] = entry.values
    if (entry.values.size === 1 && only !== undefined && entry.sessions.size >= MIN_CONSTANT_SESSIONS)
      constants.set(name, only)
  }
  return constants
}

function inferHeaders(exchanges: Exchange[], redactor: Redactor, hostConstants: ReadonlyMap<string, string>): HeaderInfo[] {
  const lists = exchanges.map(exchange => exchange.request.headers.filter(header => !isBrowserManagedHeader(header.name)))
  return namesInOrder(lists).map((name) => {
    const context: RedactContext = { in: 'header', name }
    const samples = lists.flatMap((list, index) => list
      .filter(item => item.name === name)
      .map(item => ({ value: item.value, sessionId: exchanges[index]!.sessionId })))
    const present = lists.filter(list => list.some(item => item.name === name)).length
    const distinct = new Set(samples.map(sample => sample.value))
    const sessions = new Set(samples.map(sample => sample.sessionId))
    // Identical in one session says nothing: a CSRF token or a referer is the same for every
    // request of a session. Constants need two or more sessions agreeing (decision 0004).
    const [first] = distinct
    const constant = present === exchanges.length
      && distinct.size === 1
      && (sessions.size >= MIN_CONSTANT_SESSIONS || (first !== undefined && hostConstants.get(name) === first))
      && !isBrowserIdentityHeader(name)
      && !isTelemetryHeader(name)
    let schema = withExamples(inferSchema(samples, enumGuard(redactor, context)), redactor.examples(samples.map(sample => sample.value), context))
    if (isBrowserIdentityHeader(name) || isTelemetryHeader(name))
      delete schema['x-constant']
    const only = samples[0]?.value
    // A constant that the redactor would change is a secret: it must not become a default.
    if (constant && only !== undefined && redactor.value(only, context) === only)
      schema = { ...schema, default: only }
    return {
      name,
      // Being sent is not being needed: GitHub's pages send `x-fetch-nonce` with every fetch, but
      // probe showed the requests work without it. Only probe can prove a header is needed, so
      // the emitter marks a header required when `x-site-to-api-requires` lists it.
      required: false,
      constant,
      schema,
    }
  })
}

function inferCookies(exchanges: Exchange[]): ParamInfo[] {
  const lists = exchanges.map(exchange => exchange.request.cookies)
  return namesInOrder(lists).map(name => ({
    name,
    required: lists.every(list => list.some(item => item.name === name)),
    schema: { type: 'string' },
  }))
}

function mostCommonMimeType(bodies: Body[]): string {
  const counts = new Map<string, number>()
  for (const body of bodies)
    counts.set(body.mimeType, (counts.get(body.mimeType) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
}

function formObject(form: NameValue[]): Record<string, string> {
  return Object.fromEntries(form.map(field => [field.name, field.value]))
}

function inferFormSchema(items: Array<{ form: NameValue[], sessionId: string }>, redactor: Redactor): JsonSchema {
  const names = namesInOrder(items.map(item => item.form))
  const properties: Record<string, JsonSchema> = {}
  for (const name of names) {
    const samples = items.flatMap(item => item.form
      .filter(field => field.name === name)
      .map(field => ({ value: field.value, sessionId: item.sessionId })))
    properties[name] = inferStringSchema(samples, enumGuard(redactor, { in: 'form', name }))
  }
  // As for JSON bodies: present in every sample and taking more than one value.
  const required = names.filter(name => items.every(item => item.form.some(field => field.name === name))
    && new Set(items.flatMap(item => item.form.filter(field => field.name === name).map(field => field.value))).size > 1)
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

/** `application/json`, `application/ld+json`, `application/vnd.x+json`: types a JSON serializer fits. */
function isJsonMimeType(mimeType: string): boolean {
  return mimeType === 'application/json' || /^application\/[\w.-]+\+json$/.test(mimeType)
}

/**
 * The media type of a JSON body comes from its syntax, not its header: Algolia sends JSON text as
 * `application/x-www-form-urlencoded`, and a client that believed the header would serialize the
 * object as `query=...` and get `400 Expecting object or array`. The header is kept beside it.
 */
function jsonMediaType(mimeType: string): Pick<RequestBodyInfo, 'mimeType' | 'sentContentType'> {
  if (isJsonMimeType(mimeType))
    return { mimeType }
  return mimeType === ''
    ? { mimeType: 'application/json' }
    : { mimeType: 'application/json', sentContentType: mimeType }
}

function inferRequestBody(exchanges: Exchange[], redactor: Redactor): Operation['requestBody'] {
  const withBody = exchanges.filter((exchange): exchange is Exchange & { request: { body: Body } } => exchange.request.body !== null)
  if (withBody.length === 0)
    return null
  const mimeType = mostCommonMimeType(withBody.map(exchange => exchange.request.body))
  const group = withBody.filter(exchange => exchange.request.body.mimeType === mimeType)
  const bodies = group.map(exchange => exchange.request.body)

  if (bodies.every(body => body.json !== undefined)) {
    const context: RedactContext = { in: 'body' }
    return {
      ...jsonMediaType(mimeType),
      // A field sent every time with the same value is the page's setting, not a value the caller
      // must supply: request fields are required only when present in every sample and varying.
      schema: inferSchema(group.map(exchange => ({ value: exchange.request.body.json, sessionId: exchange.sessionId })), {
        ...enumGuard(redactor, context),
        required: 'varies',
      }),
      examples: redactor.examples(bodies.map(body => body.json), context),
    }
  }
  if (bodies.every(body => body.form !== null)) {
    const items = group.map(exchange => ({ form: exchange.request.body.form ?? [], sessionId: exchange.sessionId }))
    return {
      mimeType,
      schema: inferFormSchema(items, redactor),
      examples: redactor.examples(items.map(item => formObject(item.form)), { in: 'form' }),
    }
  }
  if (bodies.every(body => body.text !== null)) {
    const texts = bodies.map(body => body.text ?? '').filter(text => text.length <= MAX_TEXT_EXAMPLE_LENGTH)
    return {
      mimeType,
      schema: { type: 'string' },
      examples: redactor.examples(texts, { in: 'body' }),
    }
  }
  return {
    mimeType,
    schema: { type: 'string', format: 'binary' },
    examples: [],
  }
}

/** Names that only ever defeat caches, whatever their values look like. */
const CACHE_BUSTER_NAMES: ReadonlySet<string> = new Set([
  '_',
  'cb',
  'nonce',
  'rand',
  'cachebuster',
])
/** Names that are a cache-buster only when they carry the current time. */
const TIME_NAMES: ReadonlySet<string> = new Set([
  't',
  'ts',
  'time',
  'timestamp',
])
/** Unix time in seconds or milliseconds, between 2001 and 2033. */
const EPOCH_VALUE = /^1\d{9}(?:\d{3})?$/

/** The values one request sent: query parameters and form or top-level JSON body fields. */
function requestFields(exchange: Exchange): NameValue[] {
  const { query, body } = exchange.request
  const fields = query.map(param => ({ name: `query.${param.name}`, value: param.value }))
  if (body?.form) {
    fields.push(...body.form.map(field => ({ name: `body.${field.name}`, value: field.value })))
  }
  else if (body?.json !== null && typeof body?.json === 'object' && !Array.isArray(body.json)) {
    fields.push(...Object.entries(body.json).map(([name, value]) => ({
      name: `body.${name}`,
      value: JSON.stringify(value),
    })))
  }
  return fields
}

/**
 * Fields that only defeat caches: a different value in every sample, under a cache-buster name
 * (`_`, `cb`, `nonce`, `rand`), or under a time name (`t`, `ts`, `time`, `timestamp`) with
 * Unix-time values. They make repeats of one request look like different requests. The name is
 * always required: a 10- or 13-digit id (`itemNo`, a GTIN) or a time filter (`since`) varies
 * with meaning, and `t=search` is a selector, so none of them is dropped.
 */
function cacheBusters(exchanges: readonly Exchange[]): Set<string> {
  const values = new Map<string, string[]>()
  for (const exchange of exchanges) {
    for (const field of requestFields(exchange)) {
      values.set(field.name, [
        ...(values.get(field.name) ?? []),
        field.value,
      ])
    }
  }
  const busters = new Set<string>()
  for (const [name, seen] of values) {
    const everyTimeDifferent = seen.length === exchanges.length && new Set(seen).size === seen.length
    const bare = name.slice(name.indexOf('.') + 1)
    const lower = bare.toLowerCase()
    const looksLikeBuster = CACHE_BUSTER_NAMES.has(lower)
      || (TIME_NAMES.has(lower) && seen.every(value => EPOCH_VALUE.test(value.replace(/^"|"$/g, ''))))
    if (everyTimeDifferent && looksLikeBuster && exchanges.length > 1)
      busters.add(name)
  }
  return busters
}

/**
 * What one exchange asked for, after redaction: path, query and body, without cache-busters. Two
 * exchanges with the same identity are the same request repeated, which says nothing about what
 * the response depends on.
 */
function requestIdentity(exchange: Exchange, redactor: Redactor, busters: ReadonlySet<string>): string {
  const { path, body } = exchange.request
  const fields = requestFields(exchange)
    .filter(field => !busters.has(field.name))
    .map(field => [
      field.name,
      redactor.value(field.value, field.name.startsWith('query.')
        ? {
            in: 'query',
            name: field.name.slice(6),
          }
        : {
            in: 'body',
            name: field.name.slice(5),
          }),
    ])
  // Bodies that are not a form or a JSON object are compared whole.
  const structured = body === null || body.form !== null || (body.json !== null && typeof body.json === 'object' && !Array.isArray(body.json))
  const whole = structured
    ? null
    : body.json !== undefined
      ? redactor.json(body.json, { in: 'body' })
      : redactor.value(body.text ?? body.base64 ?? '', { in: 'body' })
  return JSON.stringify([
    redactor.value(path, { in: 'path' }),
    fields,
    whole,
  ])
}

function inferResponses(exchanges: Exchange[], redactor: Redactor): ResponseInfo[] {
  const groups = new Map<string, { status: number, mimeType: string, exchanges: Exchange[] }>()
  for (const exchange of exchanges) {
    const mimeType = exchange.response.body?.mimeType ?? ''
    const key = `${exchange.response.status} ${mimeType}`
    let group = groups.get(key)
    if (!group) {
      group = { status: exchange.response.status, mimeType, exchanges: [] }
      groups.set(key, group)
    }
    group.exchanges.push(exchange)
  }
  return [
    ...groups.values(),
  ]
    .sort((a, b) => a.status - b.status || a.mimeType.localeCompare(b.mimeType))
    .map(({ status, mimeType, exchanges: members }) => {
      const bodies = members.map(exchange => exchange.response.body)
      const isJson = bodies.length > 0 && bodies.every(body => body !== null && body.json !== undefined)
      if (!isJson) {
        return {
          status,
          mimeType,
          schema: null,
          extract: null,
          examples: [],
        }
      }
      const context: RedactContext = { in: 'response-body' }
      const busters = cacheBusters(members)
      return {
        status,
        mimeType,
        // A field is promised only when answers to two different requests all had it (decision 0034).
        schema: inferSchema(members.map(exchange => ({
          value: exchange.response.body?.json,
          sessionId: exchange.sessionId,
          request: requestIdentity(exchange, redactor, busters),
        })), {
          ...enumGuard(redactor, context),
          required: 'distinct-requests',
        }),
        extract: null,
        examples: redactor.examples(bodies.map(body => body?.json), context),
      }
    })
}

function enrichPathParams(operation: Operation, redactor: Redactor): Operation['pathParams'] {
  return operation.pathParams.map((param) => {
    const samples = operation.exchanges
      .map(exchange => ({ value: exchange.request.path.split('/').filter(segment => segment !== '')[param.index], sessionId: exchange.sessionId }))
      .filter((sample): sample is { value: string, sessionId: string } => sample.value !== undefined)
      .map(sample => ({
        value: safeDecode(sample.value),
        sessionId: sample.sessionId,
      }))
    if (samples.length === 0)
      return param
    const context: RedactContext = { in: 'path', name: param.name }
    // Path values identify one resource; an enum would wrongly limit the client to those seen.
    const schema = inferStringSchema(samples, {
      allowEnumValue: () => false,
      name: param.name,
    })
    return {
      ...param,
      schema: withExamples(schema, redactor.examples(coerceStrings(samples.map(sample => sample.value), param.name), context)),
    }
  })
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

/**
 * Infers the request and response shapes of every observed operation. Examples go through the
 * redactor; operations found only in source code are returned unchanged. GraphQL operations get
 * their `variables` and `extensions` query parameters decoded and their constants pinned
 * (decision 0027).
 */
export function inferOperationSchemas(operations: Operation[], redactor: Redactor): Operation[] {
  const hostConstants = new Map<string, Map<string, string>>()
  for (const host of new Set(operations.map(operation => operation.host)))
    hostConstants.set(host, hostConstantHeaders(operations.filter(operation => operation.host === host).flatMap(operation => operation.exchanges)))
  return operations.map((operation) => {
    const { exchanges } = operation
    if (exchanges.length === 0)
      return operation
    return pinGraphqlSchemas({
      ...operation,
      pathParams: enrichPathParams(operation, redactor),
      query: inferParams(exchanges, exchange => exchange.request.query, 'query', redactor, operation.graphql
        ? GRAPHQL_JSON_PARAMS
        : undefined),
      headers: inferHeaders(exchanges, redactor, hostConstants.get(operation.host) ?? new Map()),
      cookies: inferCookies(exchanges),
      requestBody: inferRequestBody(exchanges, redactor),
      responses: inferResponses(exchanges, redactor),
    }, redactor)
  })
}
