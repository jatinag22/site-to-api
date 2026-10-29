/**
 * The operations of a handoff folder as the MCP server serves them (decision 0043): one entry per
 * spec operation with the facts the tools answer from. Pure: specs and `flows.json` in, entries
 * out; `handoff.ts` reads the files.
 */
import type { OpenApiDocument } from '../gen/spec'
import type { FlowsDocument, GraphqlOperationType, ValueOrigin } from '../model'
import type { ReplaySubject } from '../probe/safety'
import { z } from 'zod'
import { ValueOriginSchema } from '../model'

const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const

const OperationFactsSchema = z.looseObject({
  'operationId': z.string(),
  'summary': z.string().optional(),
  'parameters': z.array(z.unknown()).optional(),
  'x-site-to-api-kind': z.enum(['api', 'page', 'bot-protection']).optional(),
  'x-site-to-api-source-only': z.boolean().optional(),
  'x-site-to-api-method-unknown': z.boolean().optional(),
  'x-site-to-api-requires': z.array(z.string()).optional(),
  'x-site-to-api-source': z.array(z.looseObject({
    file: z.string(),
    line: z.number(),
    function: z.string().nullable().optional(),
  })).optional(),
  'x-site-to-api-graphql': z.looseObject({
    endpoint: z.string(),
    operationName: z.string().nullable(),
    operationType: z.enum([
      'query',
      'mutation',
      'subscription',
      'unknown',
    ]),
    sent: z.looseObject({
      body: z.array(z.string()),
      query: z.array(z.string()),
    }).optional(),
  }).optional(),
  'x-site-to-api-dispatch': z.looseObject({
    endpoint: z.string(),
    parameter: z.string(),
    in: z.enum(['query', 'form', 'json']),
    value: z.string(),
  }).optional(),
})

/** A spec parameter as the tools describe it. */
const ParameterSchema = z.looseObject({
  'name': z.string(),
  'in': z.enum(['path', 'query', 'header', 'cookie']),
  'required': z.boolean().optional(),
  'schema': z.looseObject({
    type: z.union([
      z.string(),
      z.array(z.string()),
    ]).optional(),
    default: z.unknown().optional(),
  }).optional(),
  'x-site-to-api-constant': z.boolean().optional(),
  'x-site-to-api-origin': z.unknown().optional(),
})
type Parameter = z.infer<typeof ParameterSchema>

const PropertySchema = z.looseObject({
  'type': z.union([
    z.string(),
    z.array(z.string()),
  ]).optional(),
  'x-site-to-api-origin': z.unknown().optional(),
})

const RequestBodySchema = z.looseObject({
  required: z.boolean().optional(),
  content: z.record(z.string(), z.looseObject({
    schema: z.looseObject({
      properties: z.record(z.string(), z.unknown()).optional(),
      required: z.array(z.string()).optional(),
    }).optional(),
  })).optional(),
})

/** What the client call of an operation looks like. */
type ClientShape
  = | { kind: 'plain' }
    | { kind: 'graphql', variablesIn: 'body' | 'query' | null }
    | { kind: 'dispatch', argument: 'query' | 'body' | null }

/** One operation of a spec, with what the tools answer from. */
export interface OperationEntry extends ReplaySubject {
  host: string
  /** Folder under `client/`, and the suffix of per-host environment variables. */
  identifier: string
  /** File name inside `specs/`. */
  specFile: string
  /** Upper case, as in `flows.json`. */
  method: string
  /** Spec path; `<endpoint>#<name>` for GraphQL and dispatcher operations. */
  path: string
  summary: string
  methodUnknown: boolean
  graphql?: {
    endpoint: string
    operationName: string | null
    operationType: GraphqlOperationType
  }
  dispatch?: {
    endpoint: string
    parameter: string
    in: 'query' | 'form' | 'json'
    value: string
  }
  client: ClientShape
  /** Path item parameters, then the operation's own, as in the spec. */
  parameters: unknown[]
  /** The parameters of the path item alone (the operation object has its own). */
  pathItemParameters: unknown[]
  /** The operation object of the spec, unchanged. */
  operation: Record<string, unknown>
  /** `x-site-to-api-requires` from probe; null when probe did not work it out. */
  requires: string[] | null
  /** The operation declares a security requirement (its own or the document's). */
  secured: boolean
  sources: Array<{ file: string, line: number, function: string | null }>
  /** Flow steps that call this operation, as `<flowId>.<stepId>`. */
  steps: string[]
}

/** The host facts {@link catalogOperations} needs. */
interface CatalogHost {
  file: string
  host: string
  identifier: string
}

function clientShape(facts: z.infer<typeof OperationFactsSchema>, parameters: unknown[]): ClientShape {
  const graphql = facts['x-site-to-api-graphql']
  if (graphql) {
    const sent = graphql.sent ?? { body: [], query: [] }
    return {
      kind: 'graphql',
      variablesIn: sent.body.includes('variables')
        ? 'body'
        : sent.query.includes('variables')
          ? 'query'
          : null,
    }
  }
  const dispatch = facts['x-site-to-api-dispatch']
  if (dispatch) {
    const own = dispatch.in === 'query'
      ? parameters.some((raw) => {
          const parameter = ParameterSchema.safeParse(raw).data
          return parameter?.in === 'query' && parameter.name !== dispatch.parameter
        })
      : bodyProperties(facts).some(([name]) => name !== dispatch.parameter)
    return {
      kind: 'dispatch',
      argument: own
        ? dispatch.in === 'query'
          ? 'query'
          : 'body'
        : null,
    }
  }
  return { kind: 'plain' }
}

/** Top-level request body properties of the first media type, in spec order. */
function bodyProperties(operation: Record<string, unknown>): Array<[string, unknown]> {
  const body = RequestBodySchema.safeParse(operation.requestBody).data
  const schema = Object.values(body?.content ?? {})[0]?.schema
  return Object.entries(schema?.properties ?? {})
}

/**
 * Entries for every operation of one OpenAPI document, in spec order. `securedOperationIds` comes
 * from `describeHost`, which applies the document's default `security`.
 */
export function catalogOperations(host: CatalogHost, document: OpenApiDocument, securedOperationIds: readonly string[], flows: FlowsDocument, warnings: string[]): OperationEntry[] {
  const context: EntryContext = {
    host,
    secured: new Set(securedOperationIds),
    steps: stepsByOperation(flows),
  }
  const entries: OperationEntry[] = []
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const raw: unknown = item[method]
      if (raw === undefined)
        continue
      const parsed = OperationFactsSchema.safeParse(raw)
      if (parsed.success)
        entries.push(toEntry(context, path, method, item.parameters ?? [], parsed.data))
      else
        warnings.push(`specs/${host.file}: ${method.toUpperCase()} ${path} has no operationId or unreadable site-to-api extensions; the MCP server leaves it out.`)
    }
  }
  return entries
}

interface EntryContext {
  host: CatalogHost
  secured: ReadonlySet<string>
  steps: ReadonlyMap<string, string[]>
}

/** `<flowId>.<stepId>` of every step, per operation id, in flow order. */
function stepsByOperation(flows: FlowsDocument): Map<string, string[]> {
  const steps = new Map<string, string[]>()
  for (const flow of flows.flows) {
    for (const step of flow.steps) {
      steps.set(step.operationId, [
        ...steps.get(step.operationId) ?? [],
        `${flow.id}.${step.id}`,
      ])
    }
  }
  return steps
}

function toEntry(context: EntryContext, path: string, method: string, pathItemParameters: unknown[], facts: z.infer<typeof OperationFactsSchema>): OperationEntry {
  const parameters = [
    ...pathItemParameters,
    ...facts.parameters ?? [],
  ]
  const graphql = facts['x-site-to-api-graphql']
  const dispatch = facts['x-site-to-api-dispatch']
  return {
    host: context.host.host,
    identifier: context.host.identifier,
    specFile: context.host.file,
    operationId: facts.operationId,
    method: method.toUpperCase(),
    path,
    kind: facts['x-site-to-api-kind'] ?? 'api',
    summary: facts.summary ?? '',
    sourceOnly: facts['x-site-to-api-source-only'] === true,
    methodUnknown: facts['x-site-to-api-method-unknown'] === true,
    ...(graphql
      ? {
          graphql: { endpoint: graphql.endpoint, operationName: graphql.operationName, operationType: graphql.operationType },
        }
      : {}),
    ...(dispatch
      ? {
          dispatch: {
            endpoint: dispatch.endpoint,
            parameter: dispatch.parameter,
            in: dispatch.in,
            value: dispatch.value,
          },
        }
      : {}),
    client: clientShape(facts, parameters),
    parameters,
    pathItemParameters,
    operation: facts,
    requires: facts['x-site-to-api-requires'] ?? null,
    secured: context.secured.has(facts.operationId),
    sources: (facts['x-site-to-api-source'] ?? []).map(ref => ({ file: ref.file, line: ref.line, function: ref.function ?? null })),
    steps: context.steps.get(facts.operationId) ?? [],
  }
}

/** Search terms: lower-case words, so `GET /api/products` matches `getApiProducts`. */
function terms(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter(term => term !== '')
}

/** Text an operation is found by. */
function haystack(entry: OperationEntry): string {
  return [
    entry.operationId,
    entry.method,
    entry.path,
    entry.summary,
    entry.graphql?.operationName ?? '',
    entry.dispatch?.value ?? '',
  ].join(' ').toLowerCase()
}

/** Filters for {@link searchOperations}. */
export interface SearchFilters {
  query?: string
  host?: string
  kind?: OperationEntry['kind']
  limit: number
  offset: number
}

/**
 * Operations matching every word of `query` (in the id, method, path, summary, GraphQL name or
 * dispatcher value), on `host` and of `kind`. Matches in the id or path rank first; ties keep
 * spec order, so the same query always gives the same page.
 */
export function searchOperations(entries: readonly OperationEntry[], filters: SearchFilters): { total: number, items: OperationEntry[] } {
  const words = terms(filters.query ?? '')
  const matched = entries
    .map((entry, index) => ({
      entry,
      index,
      text: haystack(entry),
      key: `${entry.operationId} ${entry.path}`.toLowerCase(),
    }))
    .filter(({ entry, text }) => (filters.host === undefined || entry.host === filters.host)
      && (filters.kind === undefined || entry.kind === filters.kind)
      && words.every(word => text.includes(word)))
    .map(candidate => ({ ...candidate, score: words.filter(word => candidate.key.includes(word)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  return {
    total: matched.length,
    items: matched.slice(filters.offset, filters.offset + filters.limit).map(({ entry }) => entry),
  }
}

/** The operation `operationId` (on `host`, when several hosts have one), or why there is none. */
export function findOperation(entries: readonly OperationEntry[], operationId: string, host?: string): OperationEntry | string {
  const matches = entries.filter(entry => entry.operationId === operationId && (host === undefined || entry.host === host))
  const [first] = matches
  if (first === undefined) {
    return host === undefined
      ? `No operation ${JSON.stringify(operationId)}. Use search_operations to find operation ids.`
      : `No operation ${JSON.stringify(operationId)} on host ${JSON.stringify(host)}. Use list_hosts and search_operations to find it.`
  }
  if (matches.length > 1)
    return `${matches.length} hosts have an operation ${JSON.stringify(operationId)} (${matches.map(entry => entry.host).join(', ')}); pass host to pick one.`
  return first
}

/**
 * A copy of a spec fragment without `example` and `examples`, which `get_examples` serves on its
 * own (and refuses when the folder holds raw examples). Keys of a `properties` map are field
 * names, not keywords, so a field called `examples` stays.
 */
export function withoutExamples(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value))
    return value.map(item => withoutExamples(item))
  if (typeof value !== 'object' || value === null)
    return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => propertyMap || (key !== 'example' && key !== 'examples'))
    .map(([key, child]) => [
      key,
      withoutExamples(child, !propertyMap && (key === 'properties' || key === 'patternProperties')),
    ]))
}

/** Where an input value comes from, as one line of text. */
export function describeOrigin(origin: ValueOrigin, flowId: string | null, operationOfStep: (reference: string) => string | null): string {
  const step = (reference: string): string => {
    const qualified = reference.includes('.') || flowId === null
      ? reference
      : `${flowId}.${reference}`
    const operation = operationOfStep(qualified)
    return operation === null
      ? qualified
      : `${qualified} (${operation})`
  }
  switch (origin.kind) {
    case 'step':
      return `response of ${step(origin.step)} at ${origin.output}${origin.transform === 'none'
        ? ''
        : ` (${origin.transform})`}`
    case 'html':
      return `${origin.selector === ''
        ? 'the text'
        : `html ${origin.repeated === true
          ? 'one of the elements matching '
          : ''}${origin.selector}${origin.attr === null
          ? ''
          : ` @${origin.attr}`}`}${origin.pattern === null
        ? ''
        : ` matching ${origin.pattern}`} of the response of ${step(origin.step)}${origin.confidence === 'low'
        ? ' (low confidence)'
        : ''}`
    case 'user-input':
      return `typed by the person into ${origin.field}`
    case 'computed':
      return `computed by the page's code (computed value ${origin.computedId}; see get_source)`
    case 'constant':
      return 'constant: send the captured value'
    case 'browser':
      return `set by the browser: ${origin.note}`
    case 'unknown':
      return `unknown (${origin.shape})`
  }
}

/** One input of an operation and where its value comes from. */
export interface OperationInput {
  /** As in `flows.json`, with path parameters by name: `path.productId`, `header.x-csrf-token`, `body./password`. */
  location: string
  required: boolean
  type: string | null
  /** The value the generated client sends by itself (a captured constant header), if any. */
  constant?: unknown
  origin: ValueOrigin | null
  from: string
}

function typeOf(schema: { type?: string | string[] } | undefined): string | null {
  if (schema?.type === undefined)
    return null
  return Array.isArray(schema.type)
    ? schema.type.join(' | ')
    : schema.type
}

/** The step reference → operation id map of `flows.json`. */
function stepOperations(flows: FlowsDocument): (reference: string) => string | null {
  const map = new Map<string, string>()
  for (const flow of flows.flows) {
    for (const step of flow.steps)
      map.set(`${flow.id}.${step.id}`, step.operationId)
  }
  return reference => map.get(reference) ?? null
}

/** The first origin each input location has in a flow step that calls the operation, in flow order. */
function firstFlowInputs(operationId: string, flows: FlowsDocument): Map<string, { origin: ValueOrigin, flowId: string }> {
  const inputs = new Map<string, { origin: ValueOrigin, flowId: string }>()
  const steps = flows.flows.flatMap(flow => flow.steps.filter(step => step.operationId === operationId).map(step => ({ flowId: flow.id, step })))
  for (const { flowId, step } of steps) {
    for (const [location, origin] of Object.entries(step.inputs)) {
      if (!inputs.has(location))
        inputs.set(location, { origin, flowId })
    }
  }
  return inputs
}

/** The inputs the spec declares: parameters, then top-level body fields. */
function specInputs(entry: OperationEntry): Array<{ location: string, required: boolean, type: string | null, origin: unknown, constant: unknown }> {
  const parameters = entry.parameters.flatMap((raw) => {
    const parameter: Parameter | undefined = ParameterSchema.safeParse(raw).data
    return parameter === undefined
      ? []
      : [
          {
            location: `${parameter.in}.${parameter.name}`,
            required: parameter.required === true,
            type: typeOf(parameter.schema),
            origin: parameter['x-site-to-api-origin'],
            constant: parameter['x-site-to-api-constant'] === true
              ? parameter.schema?.default
              : undefined,
          },
        ]
  })
  const body = RequestBodySchema.safeParse(entry.operation.requestBody).data
  const required = new Set(Object.values(body?.content ?? {})[0]?.schema?.required ?? [])
  const fields = bodyProperties(entry.operation).map(([name, raw]) => {
    const property = PropertySchema.safeParse(raw).data
    return {
      location: `body./${name}`,
      required: required.has(name),
      type: typeOf(property),
      origin: property?.['x-site-to-api-origin'],
      constant: undefined,
    }
  })
  return [
    ...parameters,
    ...fields,
  ]
}

/**
 * Every input of the operation: the spec's parameters and top-level body fields, with the origin
 * the spec records, then inputs only `flows.json` knows (nested body fields), with theirs.
 */
export function operationInputs(entry: OperationEntry, flows: FlowsDocument): OperationInput[] {
  const operationOfStep = stepOperations(flows)
  const flowInputs = firstFlowInputs(entry.operationId, flows)
  // `build` writes the first origin across flows in flow order, with that flow's step ids
  // (emit/openapi); with no matching flow input, the first flow that calls the operation.
  const defaultFlow = entry.steps[0]?.split('.')[0] ?? null
  const inputs: OperationInput[] = specInputs(entry).map((input) => {
    const fromFlows = flowInputs.get(input.location)
    const origin = ValueOriginSchema.safeParse(input.origin).data ?? fromFlows?.origin ?? null
    return {
      location: input.location,
      required: input.required,
      type: input.type,
      ...(input.constant === undefined
        ? {}
        : { constant: input.constant }),
      origin,
      from: origin === null
        ? 'not traced: no captured response or page code produced it'
        : describeOrigin(origin, fromFlows?.flowId ?? defaultFlow, operationOfStep),
    }
  })
  const seen = new Set(inputs.map(input => input.location))
  // Path inputs in flows.json are segment indexes (`path.2`); the spec names them already.
  for (const [location, { origin, flowId }] of flowInputs) {
    if (!seen.has(location) && !location.startsWith('path.')) {
      inputs.push({
        location,
        required: false,
        type: null,
        origin,
        from: describeOrigin(origin, flowId, operationOfStep),
      })
    }
  }
  return inputs
}

/** `x-csrf-token` → `xCsrfToken`; a valid identifier for a placeholder in example code. */
function placeholder(name: string): string {
  const words = name.split(/[^a-z0-9]+/i).filter(Boolean)
  const camel = words.map((word, index) => index === 0
    ? word.charAt(0).toLowerCase() + word.slice(1)
    : word.charAt(0).toUpperCase() + word.slice(1)).join('')
  return /^[a-z_$]/i.test(camel)
    ? camel
    : `value${camel}`
}

function objectLiteral(names: readonly string[]): string {
  const fields = names.map((name) => {
    const variable = placeholder(name)
    return variable === name
      ? name
      : `${JSON.stringify(name)}: ${variable}`
  })
  return `{ ${fields.join(', ')} }`
}

/** The SDK options other than headers: what each kind of client function takes. */
function optionParts(entry: OperationEntry, named: (prefix: string) => string[]): string[] {
  const shape = entry.client
  if (shape.kind === 'graphql') {
    return shape.variablesIn === null
      ? []
      : ['variables']
  }
  if (shape.kind === 'dispatch') {
    if (shape.argument === null)
      return []
    const own = named(shape.argument === 'query'
      ? 'query.'
      : 'body./').filter(name => name !== entry.dispatch?.parameter)
    return own.length > 0
      ? [`${shape.argument}: ${objectLiteral(own)}`]
      : []
  }
  return ([
    [
      'path',
      named('path.'),
    ],
    [
      'query',
      named('query.'),
    ],
    [
      'body',
      named('body./').filter(name => !name.includes('/')),
    ],
  ] as const).filter(([, names]) => names.length > 0).map(([key, names]) => `${key}: ${objectLiteral(names)}`)
}

/** Options of the SDK call, as code with a placeholder variable per input. */
export function clientArguments(entry: OperationEntry, inputs: readonly OperationInput[]): string {
  const named = (prefix: string): string[] => inputs
    .filter(input => input.location.startsWith(prefix) && input.constant === undefined)
    .map(input => input.location.slice(prefix.length))
  // Headers the page computed or read from a response; the client sends the constant ones itself.
  const headers = inputs
    .filter(input => input.location.startsWith('header.') && input.constant === undefined
      && (input.required || (input.origin !== null && ['step', 'html', 'computed'].includes(input.origin.kind))))
    .map(input => input.location.slice('header.'.length))
  const parts = [
    ...optionParts(entry, named),
    ...(headers.length > 0
      ? [`headers: ${objectLiteral(headers)}`]
      : []),
  ]
  return parts.length === 0
    ? '{}'
    : `{ ${parts.join(', ')} }`
}
