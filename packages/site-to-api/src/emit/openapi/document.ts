/**
 * Builds one OpenAPI 3.1 document per host from an {@link Analysis} (docs/output-format.md).
 * Objects are built with a fixed key order so the YAML is byte-identical for the same analysis.
 */
import type { Analysis, DispatchOperation, GraphqlOperation, JsonSchema, Operation, ParamInfo, ResponseInfo, SourceRef, ValueOrigin } from '../../model'
import { isTelemetryHeader } from '../../analyze/schema'
import { createStepResolver, operationKey } from '../steps'

const OPENAPI_VERSION = '3.1.0'

/** OpenAPI path item fields, in the order they are written. */
const METHODS: readonly string[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]

/**
 * Headers OpenAPI describes elsewhere: `Content-Type` is the request body media type, `Accept`
 * the response media types, `Authorization` a security scheme. The spec says parameters with
 * these names are ignored, so they are not written as parameters.
 */
const NOT_PARAMETERS = new Set(['accept', 'content-type', 'authorization'])

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

type Json = Record<string, unknown>

function isJson(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Copies a schema in its own key order, dropping empty keys, so the output never has `undefined`. */
export function schemaObject(schema: JsonSchema): Json {
  const result: Json = {}
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined)
      continue
    if (key === 'properties' && schema.properties) {
      result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [
        name,
        schemaObject(child),
      ]))
    }
    else if (key === 'items' && schema.items) {
      result.items = schemaObject(schema.items)
    }
    else if (key === 'additionalProperties' && typeof schema.additionalProperties === 'object') {
      result.additionalProperties = schemaObject(schema.additionalProperties)
    }
    else if (key === 'anyOf' && schema.anyOf) {
      result.anyOf = schema.anyOf.map(schemaObject)
    }
    else {
      result[key] = value
    }
  }
  return result
}

/**
 * First origin per operation input across all flows, in flow order, keyed by
 * {@link operationKey}: two hosts can share an operation id, and each must keep its own inputs.
 */
function originsByOperation(analysis: Analysis): Map<string, Map<string, ValueOrigin>> {
  const resolver = createStepResolver(analysis.operations, analysis.flows)
  const seen = new Map<string, Map<string, ValueOrigin[]>>()
  for (const step of analysis.flows.flows.flatMap(flow => flow.steps)) {
    const operation = resolver.operation(step)
    if (!operation)
      continue
    const key = operationKey(operation.host, operation.operationId)
    const inputs = seen.get(key) ?? new Map<string, ValueOrigin[]>()
    seen.set(key, inputs)
    for (const [input, origin] of Object.entries(step.inputs)) {
      inputs.set(input, [
        ...(inputs.get(input) ?? []),
        origin,
      ])
    }
  }
  const result = new Map<string, Map<string, ValueOrigin>>()
  for (const [key, inputs] of seen) {
    const chosen = new Map<string, ValueOrigin>()
    for (const [input, origins] of inputs) {
      const origin = operationOrigin(origins)
      if (origin !== null)
        chosen.set(input, origin)
    }
    result.set(key, chosen)
  }
  return result
}

/**
 * One origin for an operation input seen in several steps: the first that says where the value
 * comes from (a response, a computation, typing…) beats an unknown, and a constant holds only
 * when every step sent that same constant. Next.js sent `next-router-segment-prefetch: /_tree`
 * in one step and `/!KG5…/__PAGE__` in another: that is no constant, so no origin is written.
 */
function operationOrigin(origins: readonly ValueOrigin[]): ValueOrigin | null {
  const informative = origins.find(origin => origin.kind !== 'unknown' && origin.kind !== 'constant')
  if (informative !== undefined)
    return informative
  const constants = origins.filter(origin => origin.kind === 'constant')
  if (constants.length === 0)
    return origins[0] ?? null
  const values = new Set(constants.map(origin => JSON.stringify(origin)))
  return values.size === 1 && constants.length === origins.length
    ? constants[0] ?? null
    : null
}

function originExtensions(origin: ValueOrigin | undefined): Json {
  if (!origin)
    return {}
  return origin.kind === 'computed'
    ? { 'x-site-to-api-origin': origin, 'x-site-to-api-computed': origin.computedId }
    : { 'x-site-to-api-origin': origin }
}

function sourceExtension(refs: SourceRef[]): Json {
  if (refs.length === 0)
    return {}
  return {
    'x-site-to-api-source': refs.map(ref => ({ file: ref.file, line: ref.line, function: ref.functionName })),
  }
}

function parameter(where: 'path' | 'query' | 'header' | 'cookie', param: ParamInfo, origins: Map<string, ValueOrigin>, extra: Json = {}): Json {
  return {
    name: param.name,
    in: where,
    required: where === 'path'
      ? true
      : param.required,
    // JSON text in a query string (GraphQL `variables`): OpenAPI describes it as a media type.
    ...(param.json === true
      ? {
          content: {
            'application/json': {
              schema: schemaObject(param.schema),
            },
          },
        }
      : {
          schema: schemaObject(param.schema),
        }),
    ...extra,
    ...originExtensions(origins.get(`${where}.${param.name}`)),
  }
}

function hasDefault(header: Operation['headers'][number]): boolean {
  return header.constant && header.schema.default !== undefined
}

/**
 * A header is required when probe proved the request fails without it (`header:<name>` in
 * `x-site-to-api-requires`), or, for an operation probe did not minimize, when every sample sent
 * it. A constant with a default is sent by the client itself, and tracing headers are never
 * needed by the server.
 */
function headerRequired(operation: Operation, header: Operation['headers'][number]): boolean {
  if (hasDefault(header) || isTelemetryHeader(header.name))
    return false
  return probedRequired(operation, `header:${header.name.toLowerCase()}`) ?? header.required
}

/**
 * What probe measured about one need (`cookie:__cf_bm`): needed or not when the operation was
 * minimized, `null` when it was not. A measurement beats "present in every sample": Cloudflare's
 * `__cf_bm` is sent with every request yet none of them needs it.
 */
function probedRequired(operation: Operation, need: string): boolean | null {
  return Array.isArray(operation.requires)
    ? operation.requires.includes(need)
    : null
}

function parameters(operation: Operation, origins: Map<string, ValueOrigin>): Json[] {
  return [
    ...operation.pathParams.map(param => parameter('path', { name: param.name, required: true, schema: param.schema }, origins)),
    ...operation.query.map(param => parameter('query', param, origins)),
    ...operation.headers
      .filter(header => !NOT_PARAMETERS.has(header.name))
      .map(header => parameter('header', {
        ...header,
        required: headerRequired(operation, header),
      }, origins, header.constant
        ? { 'x-site-to-api-constant': true }
        : {})),
    // Cookie values never appear in the spec: the schema is a bare string.
    ...operation.cookies.map(cookie => parameter('cookie', {
      name: cookie.name,
      required: probedRequired(operation, `cookie:${cookie.name}`) ?? cookie.required,
      schema: { type: 'string' },
    }, origins)),
  ]
}

function examplesObject(examples: unknown[]): Json {
  if (examples.length === 0)
    return {}
  return {
    examples: Object.fromEntries(examples.map((value, index) => [
      `example${index + 1}`,
      { value },
    ])),
  }
}

/** `body./a/b` → `['a', 'b']` (JSON Pointer), `form.a` → `['a']`; other inputs → `null`. */
function bodyPointer(input: string): string[] | null {
  if (input.startsWith('form.')) {
    return [
      input.slice('form.'.length),
    ]
  }
  if (input.startsWith('body./'))
    return input.slice('body./'.length).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  return null
}

function propertyAt(schema: Json, pointer: string[]): Json | undefined {
  let target: Json | undefined = schema
  for (const part of pointer) {
    const properties: unknown = target?.properties
    // Own properties only: a request field named `__proto__` or `constructor` must not reach
    // Object.prototype, which annotateBody would then write into.
    const next: unknown = isJson(properties) && Object.hasOwn(properties, part)
      ? properties[part]
      : undefined
    target = isJson(next)
      ? next
      : undefined
  }
  return target
}

/** Marks computed body properties (`body./password`) and other origins on the request body schema. */
function annotateBody(schema: Json, origins: Map<string, ValueOrigin>): Json {
  for (const [input, origin] of [...origins].sort(([a], [b]) => a.localeCompare(b))) {
    const pointer = bodyPointer(input)
    const target = pointer
      ? propertyAt(schema, pointer)
      : undefined
    if (target)
      Object.assign(target, originExtensions(origin))
  }
  return schema
}

function requestBody(operation: Operation, origins: Map<string, ValueOrigin>): Json {
  const body = operation.requestBody
  if (!body)
    return {}
  return {
    requestBody: {
      required: true,
      content: {
        [body.mimeType || 'application/octet-stream']: {
          schema: annotateBody(schemaObject(body.schema), origins),
          ...examplesObject(body.examples),
          // JSON text the site labels as another type; gen makes the client send that header.
          ...(body.sentContentType === undefined
            ? {}
            : { 'x-site-to-api-content-type': body.sentContentType }),
        },
      },
    },
  }
}

function mediaType(response: ResponseInfo): Json {
  if (response.schema) {
    return {
      schema: schemaObject(response.schema),
      ...examplesObject(response.examples),
    }
  }
  const isBinary = !/^text\/|json|xml|javascript|csv/.test(response.mimeType)
  return {
    schema: isBinary
      ? { type: 'string', format: 'binary' }
      : { type: 'string' },
    ...(response.extract
      ? { 'x-site-to-api-extract': response.extract.spec }
      : {}),
    ...examplesObject(response.examples),
  }
}

function responseObject(status: number, list: ResponseInfo[]): Json {
  const content = Object.fromEntries(list
    .filter(response => response.mimeType !== '')
    .sort((a, b) => a.mimeType.localeCompare(b.mimeType))
    .map(response => [
      response.mimeType,
      mediaType(response),
    ]))
  const fallback = isHttpStatus(status)
    ? `Status ${status}`
    : 'Request failed in the browser.'
  return {
    description: STATUS_TEXT[status] ?? fallback,
    ...(Object.keys(content).length > 0
      ? { content }
      : {}),
  }
}

/** Status 0 means the request failed in the browser (blocked, aborted): no HTTP status exists. */
function isHttpStatus(status: number): boolean {
  return status >= 100 && status <= 599
}

function responses(operation: Operation): Json {
  if (operation.responses.length === 0) {
    return {
      default: {
        description: operation.sourceOnly ? 'Not observed during capture.' : 'No response recorded.',
      },
    }
  }
  const byStatus = new Map<number, ResponseInfo[]>()
  for (const response of operation.responses) {
    byStatus.set(response.status, [
      ...(byStatus.get(response.status) ?? []),
      response,
    ])
  }
  const result: Json = {}
  for (const status of [
    ...byStatus.keys(),
  ].sort((a, b) => a - b)) {
    result[isHttpStatus(status)
      ? String(status)
      : 'default'] = responseObject(status, byStatus.get(status) ?? [])
  }
  return result
}

function usesAuthorization(operation: Operation): boolean {
  return operation.headers.some(header => header.name === 'authorization')
}

/**
 * `x-site-to-api-graphql` (decision 0027): what makes this path item one GraphQL operation, and
 * what the generated client sends for it.
 */
function graphqlExtension(graphql: GraphqlOperation): Json {
  return {
    'x-site-to-api-graphql': {
      endpoint: graphql.endpoint,
      operationName: graphql.operationName,
      operationType: graphql.operationType,
      operationTypeFrom: graphql.operationTypeFrom,
      persistedQuery: graphql.persistedQuery,
      ...(graphql.hashes.length > 1
        ? { hashes: graphql.hashes }
        : {}),
      document: graphql.document,
      batched: graphql.batched,
      sent: graphql.sent,
    },
  }
}

/**
 * `x-site-to-api-dispatch` (decision 0039): the dispatcher parameter this operation sends, where,
 * and with which value; the path is `<endpoint>#<value>`, and the request goes to the endpoint.
 */
function dispatchExtension(dispatch: DispatchOperation): Json {
  return {
    'x-site-to-api-dispatch': {
      endpoint: dispatch.endpoint,
      parameter: dispatch.parameter,
      in: dispatch.in,
      value: dispatch.value,
    },
  }
}

function operationObject(operation: Operation, origins: Map<string, ValueOrigin>): Json {
  const params = parameters(operation, origins)
  return {
    'operationId': operation.operationId,
    'summary': operation.summary,
    ...(params.length > 0
      ? { parameters: params }
      : {}),
    ...requestBody(operation, origins),
    'responses': responses(operation),
    ...(usesAuthorization(operation)
      ? {
          security: [
            { authorization: [] },
          ],
        }
      : {}),
    'x-site-to-api-kind': operation.kind,
    ...(operation.graphql
      ? graphqlExtension(operation.graphql)
      : {}),
    ...(operation.dispatch
      ? dispatchExtension(operation.dispatch)
      : {}),
    ...sourceExtension(operation.sentFrom),
    ...(operation.sourceOnly
      ? { 'x-site-to-api-source-only': true }
      : {}),
    // The code called this URL without a literal method, so the method key above is a placeholder.
    ...(operation.methodUnknown === true
      ? { 'x-site-to-api-method-unknown': true }
      : {}),
    ...(operation.requires
      ? { 'x-site-to-api-requires': operation.requires }
      : {}),
  }
}

function serverUrl(host: string, operations: Operation[]): string {
  const urls = operations.flatMap(operation => operation.exchanges.map(exchange => exchange.request.url))
  const plainHttp = urls.length > 0 && urls.every(url => url.startsWith('http:'))
  return `${plainHttp ? 'http' : 'https'}://${host}`
}

function hostDocument(host: string, operations: Operation[], analysis: Analysis, origins: Map<string, Map<string, ValueOrigin>>): Json {
  const paths = new Map<string, Json>()
  const unsupported: string[] = []
  const sorted = [...operations].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  for (const operation of sorted) {
    const method = operation.method.toLowerCase()
    if (!METHODS.includes(method)) {
      unsupported.push(`${operation.method} ${operation.path}`)
      continue
    }
    const item = paths.get(operation.path) ?? {}
    item[method] = operationObject(operation, origins.get(operationKey(operation.host, operation.operationId)) ?? new Map())
    paths.set(operation.path, item)
  }
  const orderedPaths = Object.fromEntries([...paths].map(([path, item]) =>
    [
      path,
      Object.fromEntries(METHODS.filter(method => method in item).map(method => [method, item[method]])),
    ]))
  const sessions = analysis.sessions.length
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: host,
      version: '0.0.0',
      description: `Endpoints of ${host} as observed in ${sessions} capture session${sessions === 1
        ? ''
        : 's'} by site-to-api. Example values are redacted.`,
    },
    servers: [
      {
        url: serverUrl(host, operations),
      },
    ],
    paths: orderedPaths,
    ...(operations.some(usesAuthorization)
      ? {
          components: {
            securitySchemes: {
              authorization: { type: 'apiKey', in: 'header', name: 'Authorization' },
            },
          },
        }
      : {}),
    ...(unsupported.length > 0
      ? { 'x-site-to-api-unsupported-methods': unsupported }
      : {}),
  }
}

/**
 * One OpenAPI 3.1 document per host (OpenAPI servers cannot mix hosts), keyed by host and
 * sorted by host. Operations of every kind are included and tagged with `x-site-to-api-kind`,
 * so `gen` can skip pages and bot-protection steps.
 */
export function buildOpenApiDocuments(analysis: Analysis): Map<string, object> {
  const origins = originsByOperation(analysis)
  const byHost = new Map<string, Operation[]>()
  for (const operation of analysis.operations) {
    byHost.set(operation.host, [
      ...(byHost.get(operation.host) ?? []),
      operation,
    ])
  }
  const documents = new Map<string, object>()
  for (const host of [
    ...byHost.keys(),
  ].sort())
    documents.set(host, hostDocument(host, byHost.get(host) ?? [], analysis, origins))
  return documents
}
