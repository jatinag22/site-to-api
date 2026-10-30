/**
 * Groups exchanges into operations by host + method + path template.
 */
import type { DispatchOperation, Exchange, Operation, PathParam, SourceRoute } from '../../model'
import type { GraphqlExchange } from '../graphql'
import type { Dispatcher } from './dispatch'
import type { Evidence, Marks } from './templates'
import { isUsableFunctionName } from '../../emit/naming'
import { isChallengeAnswer } from '../classify'
import { graphqlGroupKey, graphqlOperationId, graphqlOperationOf, graphqlSpecPath, graphqlSummary, isGraphqlExchange } from '../graphql'
import { isRpcExchange, rpcGroupKey, rpcOperationOf, rpcSummary } from '../rpc'
import { inferStringSchema } from '../schema'
import { detectDispatcher } from './dispatch'
import { isSlug } from './identifiers'
import { linkedSlugs, titledSlugPaths } from './links'
import { camelCase, nounFor, operationIdFor, pathPhrase, singular, words } from './naming'
import { siblingFacts } from './siblings'
import { markParameters, parseTemplate, segmentsOf, templateMatches } from './templates'

interface BuildOperationsOptions {
  /** Endpoints found in the site's code (from `analyze/source`); may be empty. */
  sourceRoutes: SourceRoute[]
  /**
   * The redactor's verdict on object keys (decision 0042). Summaries list response fields, and a
   * key that is a token or personal value is written as `{key}` there instead.
   */
  isSecretKey: (key: string) => boolean
  /**
   * True for a value that is a static string literal in the site's own code and that value
   * tracing found no response, page or typed origin for (decision 0053): a code route's
   * parameter whose values are all such literals names different endpoints. Never, when omitted.
   */
  codeLiteral?: (value: string) => boolean
}

/** Written in summaries instead of a response key that is a secret or personal value. */
const KEY_PLACEHOLDER = '{key}'

const OPERATION_KINDS = new Set(['api', 'page', 'bot-protection'])
const EVIDENCE_ORDER: Evidence[] = [
  'source-template',
  'value-trace',
  'varies',
  'looks-like-id',
]
const MAX_SUMMARY_FIELDS = 8

type OperationKind = Operation['kind']

interface Classified {
  exchange: Exchange
  segments: string[]
  marks: Marks
}

function routesFor(routes: SourceRoute[], host: string, method: string | null): SourceRoute[] {
  return routes.filter(route => (route.host === null || route.host === host)
    && (route.method === null || method === null || route.method.toUpperCase() === method))
}

function structure(segments: string[], marks: Marks): string {
  return segments.map((segment, index) => marks.has(index)
    ? '{}'
    : segment).join('/')
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

/** Names the site's own code gave to path values: host → value → name → count. */
type SourceNames = Map<string, Map<string, Map<string, number>>>

function sourceNamesOf(classified: Classified[]): SourceNames {
  const result: SourceNames = new Map()
  for (const item of classified) {
    for (const [index, mark] of item.marks) {
      if (!mark.sourceName)
        continue
      const byValue = result.get(item.exchange.request.host) ?? new Map<string, Map<string, number>>()
      result.set(item.exchange.request.host, byValue)
      const value = item.segments[index] ?? ''
      const names = byValue.get(value) ?? new Map<string, number>()
      byValue.set(value, names)
      const name = camelCase(mark.sourceName) || mark.sourceName
      names.set(name, (names.get(name) ?? 0) + 1)
    }
  }
  return result
}

/**
 * The name a source route gave to the same values on the same host (`/{owner}/{repo}/_file_tree`
 * names `expressjs` in `/expressjs/express/latest-commit`): the most used one, then the shortest.
 */
function borrowedName(values: string[], byValue: Map<string, Map<string, number>> | undefined): string | null {
  if (!byValue)
    return null
  const counts = new Map<string, number>()
  for (const value of new Set(values)) {
    for (const [name, count] of byValue.get(value) ?? [])
      counts.set(name, (counts.get(name) ?? 0) + count)
  }
  const ranked = [
    ...counts,
  ].sort(([a, x], [b, y]) => y - x || a.length - b.length || a.localeCompare(b))
  return ranked[0]?.[0] ?? null
}

interface NameInput {
  sourceName: string | undefined
  borrowed: string | null
  previous: string | undefined
  values: string[]
  /** Words rather than ids (`Alan_Turing`, `python`): named after what they are, not `…Id`. */
  wordValues: boolean
  ordinal: number
}

/** Segments that say where the API lives, not what the value is (`/api/v1/{v1}`). */
const NOT_A_NAME = /^(?:v\d+(?:\.\d+)*|api|apis|rest)$/i

function nameFor(input: NameInput): string {
  return nameFromPrevious({
    ...input,
    previous: input.previous !== undefined && NOT_A_NAME.test(input.previous)
      ? undefined
      : input.previous,
  })
}

function nameFromPrevious({ sourceName, borrowed, previous, values, wordValues, ordinal }: NameInput): string {
  if (sourceName)
    return camelCase(sourceName) || sourceName
  if (borrowed)
    return borrowed
  const previousWords = previous
    ? words(previous).length
    : 0
  if (values.every(isSlug)) {
    return previousWords > 0 || wordValues
      ? 'slug'
      : `param${ordinal + 1}`
  }
  if (!previous || previousWords === 0)
    return `param${ordinal + 1}`
  if (!wordValues)
    return `${camelCase(singular(previous))}Id`
  // A one-word section names the thing (`tagged` → `tag`); a phrase (`getting-started`) does not.
  return previousWords === 1
    ? nounFor(previous)
    : 'slug'
}

/** Names the parameters of one structural path, shared by every method on that path. */
function nameParameters(members: Classified[], sourceNames: SourceNames): Map<number, string> {
  const positions = [
    ...new Set(members.flatMap(member => [
      ...member.marks.keys(),
    ])),
  ].sort((a, b) => a - b)
  const names = new Map<number, string>()
  const used = new Set<string>()
  const byValue = sourceNames.get(members[0]!.exchange.request.host)
  positions.forEach((index, ordinal) => {
    const values = members.map(member => member.segments[index] ?? '')
    const name = nameFor({
      sourceName: members.map(member => member.marks.get(index)?.sourceName ?? undefined).find(found => found),
      borrowed: borrowedName(values, byValue),
      previous: index > 0 && !positions.includes(index - 1)
        ? members[0]!.segments[index - 1]
        : undefined,
      values,
      wordValues: !members.some(member => member.marks.get(index)?.evidence.includes('looks-like-id')),
      ordinal,
    })
    let unique = name
    for (let suffix = 2; used.has(unique); suffix++)
      unique = `${name}${suffix}`
    used.add(unique)
    names.set(index, unique)
  })
  return names
}

/** A response key as a summary lists it: `{key}` when it is a secret or personal value. */
function summaryField(key: string, isSecretKey: (key: string) => boolean): string {
  return isSecretKey(key)
    ? KEY_PLACEHOLDER
    : key
}

function responseFields(exchanges: Exchange[], isSecretKey: (key: string) => boolean): { list: boolean, fields: string[] } | null {
  const fields = new Set<string>()
  let list = false
  for (const exchange of exchanges) {
    const { status, body } = exchange.response
    if (status < 200 || status >= 300 || body === null || body.json === undefined)
      continue
    let value = body.json
    if (Array.isArray(value)) {
      list = true
      value = value.find(item => item !== null && typeof item === 'object' && !Array.isArray(item))
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      Object.keys(value).forEach(key => fields.add(summaryField(key, isSecretKey)))
  }
  return fields.size === 0
    ? null
    : {
        list,
        fields: [...fields],
      }
}

function withResponseFields(base: string, exchanges: Exchange[], isSecretKey: (key: string) => boolean): string {
  const response = responseFields(exchanges, isSecretKey)
  if (!response)
    return base
  const shown = response.fields.slice(0, MAX_SUMMARY_FIELDS)
  const more = response.fields.length > shown.length
    ? `, +${response.fields.length - shown.length} more`
    : ''
  return `${base} Returns ${response.list ? 'a list of ' : ''}${shown.join(', ')}${more}.`
}

function summarize(kind: OperationKind, method: string, path: string, exchanges: Exchange[], isSecretKey: (key: string) => boolean): string {
  const phrase = pathPhrase(path)
  if (kind === 'page') {
    return `Page ${phrase === ''
      ? 'home'
      : phrase}.`
  }
  if (kind === 'bot-protection') {
    const vendor = exchanges[0]?.kindReason.split(':')[0] ?? 'unknown vendor'
    return `Bot protection (${vendor}), browser only.`
  }
  const verb = method.charAt(0) + method.slice(1).toLowerCase()
  return withResponseFields(`${verb} ${phrase === ''
    ? 'root'
    : phrase}.`, exchanges, isSecretKey)
}

function pathParamsFor(members: Classified[], names: Map<number, string>): PathParam[] {
  return [...names].map(([index, name]) => {
    const evidence = new Set(members.flatMap(member => member.marks.get(index)?.evidence ?? []))
    const samples = members.map(member => ({
      value: decode(member.segments[index] ?? ''),
      sessionId: member.exchange.sessionId,
    }))
    return {
      name,
      index,
      schema: inferStringSchema(samples, {
        allowEnumValue: () => false,
      }),
      evidence: EVIDENCE_ORDER.filter(item => evidence.has(item)),
    }
  })
}

function templateFor(segments: string[], names: Map<number, string>): string {
  return `/${segments.map((segment, index) => names.has(index)
    ? `{${names.get(index)}}`
    : segment).join('/')}`
}

/**
 * A call that fetched the same HTML a navigation loads, or got no body: a service worker serving
 * the page (YouTube, Reddit) or a prefetch of it. Next to a navigation it is that page, not data.
 */
function copiesPage(member: Classified): boolean {
  const body = member.exchange.response.body
  return body === null || body.mimeType === 'text/html'
}

/**
 * Operation kind of a group: `api` when any member is a data call, then `page`. A top-level
 * navigation keeps the group a page when the only calls beside it fetched the same HTML (a
 * service worker answering the navigation) or nothing. A group is a bot-protection step only
 * when every member is: a page or API call that was challenged once (`x-amzn-waf-action:
 * challenge`, `cf-mitigated`) and then answered normally is still that page or call, and must
 * keep its client method.
 */
function kindOf(members: Classified[]): OperationKind {
  const kinds = new Set(members.map(member => member.exchange.kind))
  if (kinds.has('page') && members.every(member => member.exchange.kind !== 'api' || copiesPage(member)))
    return 'page'
  if (kinds.has('api'))
    return 'api'
  if (kinds.has('page'))
    return 'page'
  return 'bot-protection'
}

function capitalize(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

function emptyOperation(init: Pick<Operation, 'host' | 'method' | 'path' | 'kind' | 'pathParams' | 'summary' | 'exchanges' | 'sourceOnly' | 'methodUnknown' | 'graphql' | 'rpc'>): Operation {
  return {
    operationId: '',
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses: [],
    sentFrom: [],
    ...init,
  }
}

/**
 * One operation per GraphQL operation (decision 0027): requests that share an endpoint are told
 * apart by operation name, persisted hash or document, never merged into one path template.
 */
function graphqlOperations(exchanges: Exchange[], isSecretKey: (key: string) => boolean): Operation[] {
  const groups = new Map<string, GraphqlExchange[]>()
  for (const exchange of exchanges) {
    if (!isGraphqlExchange(exchange))
      continue
    const key = graphqlGroupKey(exchange)
    groups.set(key, [
      ...(groups.get(key) ?? []),
      exchange,
    ])
  }
  return [
    ...groups.values(),
  ].flatMap((group) => {
    const [first, ...rest] = group
    if (first === undefined)
      return []
    const graphql = graphqlOperationOf([first, ...rest])
    const pathNamesOperation = group.every(exchange => exchange.graphql.pathNamesOperation)
    return [
      emptyOperation({
        host: first.request.host,
        method: first.request.method,
        path: graphqlSpecPath(graphql, first.graphql.key, pathNamesOperation),
        kind: 'api',
        pathParams: [],
        summary: graphqlSummary(graphql, first.request.method, group, isSecretKey),
        exchanges: group,
        sourceOnly: false,
        graphql,
      }),
    ]
  })
}

/**
 * One operation per tRPC procedure or Connect method (decision 0051) at its literal path: the
 * procedure is in the path, so templating would merge `/a.v1.X/GetResources` with
 * `/b.v1.Y/GetResources` into `/{param1}/GetResources`.
 */
function rpcOperations(exchanges: Exchange[], isSecretKey: (key: string) => boolean): Operation[] {
  const groups = new Map<string, Array<Exchange & { rpc: NonNullable<Exchange['rpc']> }>>()
  for (const exchange of exchanges) {
    if (!isRpcExchange(exchange))
      continue
    const key = rpcGroupKey(exchange)
    groups.set(key, [
      ...(groups.get(key) ?? []),
      exchange,
    ])
  }
  return [
    ...groups.values(),
  ].flatMap((group) => {
    const first = group[0]
    const rpc = rpcOperationOf(group)
    if (first === undefined || rpc === null)
      return []
    return [
      emptyOperation({
        host: first.request.host,
        method: first.request.method,
        path: first.request.path,
        kind: 'api',
        pathParams: [],
        summary: withResponseFields(rpcSummary(rpc, first.request.method), group, isSecretKey),
        exchanges: group,
        sourceOnly: false,
        rpc,
      }),
    ]
  })
}

/** A path word a vendor's endpoint keeps fixed: `cdn-cgi`, `challenge-platform`, `h`, `oneshot`, `fp`. */
const VENDOR_PATH_WORD = /^[a-z][a-z-]{0,23}$/i

/**
 * For a request to a vendor's challenge endpoint (not a site page answered with a challenge),
 * every segment that is not a plain word is a parameter: challenge paths pack tokens, timestamps
 * and ray ids into segments (`0.41:1700000000:Hq7Z_pL2x-…`) that no id rule recognises, and a
 * literal one would be written into spec paths and operation ids.
 */
function vendorStepMarks(exchange: Exchange, segments: readonly string[], marks: Marks): Marks {
  if (exchange.kind !== 'bot-protection' || isChallengeAnswer(exchange))
    return marks
  const result: Marks = new Map(marks)
  segments.forEach((segment, index) => {
    if (segment !== '' && !result.has(index) && !VENDOR_PATH_WORD.test(segment)) {
      result.set(index, {
        evidence: ['looks-like-id'],
        sourceName: null,
      })
    }
  })
  return result
}

/**
 * The operation of one host + method + template, or one per function when a parameter picks the
 * function (decision 0039).
 */
function templateOperations(method: string, group: Classified[], names: Map<number, string>, isSecretKey: (key: string) => boolean, dispatch = true): Operation[] {
  const path = templateFor(group[0]!.segments, names)
  const kind = kindOf(group)
  const dispatcher = dispatch && kind === 'api'
    ? detectDispatcher(group.map(member => member.exchange))
    : null
  if (dispatcher) {
    // Requests without the dispatcher parameter stay one plain operation on the endpoint.
    const stray = new Set(dispatcher.rest)
    const rest = group.filter(member => stray.has(member.exchange))
    return [
      ...dispatchOperations(dispatcher, group, names, path, isSecretKey),
      ...(rest.length > 0
        ? templateOperations(method, rest, names, isSecretKey, false)
        : []),
    ]
  }
  const groupExchanges = group.map(member => member.exchange)
  return [
    emptyOperation({
      host: group[0]!.exchange.request.host,
      method,
      path,
      kind,
      pathParams: pathParamsFor(group, names),
      summary: summarize(kind, method, path, groupExchanges, isSecretKey),
      exchanges: groupExchanges,
      sourceOnly: false,
    }),
  ]
}

function observedOperations(exchanges: Exchange[], routes: SourceRoute[], isSecretKey: (key: string) => boolean, codeLiteral: (value: string) => boolean): Operation[] {
  // GraphQL requests get their own operations; templating their paths would merge them.
  // RPC calls too: their procedure is in the path (decision 0051).
  const relevant = exchanges.filter(exchange => OPERATION_KINDS.has(exchange.kind) && !isGraphqlExchange(exchange) && !isRpcExchange(exchange))
  // 1. Parameter positions per host + method.
  const byHostMethod = new Map<string, Exchange[]>()
  for (const exchange of relevant) {
    const key = `${exchange.request.host} ${exchange.request.method}`
    byHostMethod.set(key, [
      ...(byHostMethod.get(key) ?? []),
      exchange,
    ])
  }
  const classified: Classified[] = []
  for (const members of byHostMethod.values()) {
    const { host, method } = members[0]!.request
    const marks = markParameters([
      ...new Set(members.map(exchange => exchange.request.path)),
    ], routesFor(routes, host, method), linkedSlugs(members, relevant), siblingFacts(members, relevant), titledSlugPaths(members), codeLiteral)
    for (const exchange of members) {
      const segments = segmentsOf(exchange.request.path)
      classified.push({
        exchange,
        segments,
        marks: vendorStepMarks(exchange, segments, marks.get(exchange.request.path) ?? new Map()),
      })
    }
  }

  // 2. Names per host + structural path, so GET and PUT on one resource agree on names.
  const byStructure = new Map<string, Classified[]>()
  for (const item of classified) {
    const key = `${item.exchange.request.host} ${structure(item.segments, item.marks)}`
    byStructure.set(key, [
      ...(byStructure.get(key) ?? []),
      item,
    ])
  }

  // 3. One operation per host + method + template.
  const operations: Operation[] = []
  const sourceNames = sourceNamesOf(classified)
  for (const members of byStructure.values()) {
    const names = nameParameters(members, sourceNames)
    const byMethod = new Map<string, Classified[]>()
    for (const member of members) {
      byMethod.set(member.exchange.request.method, [
        ...(byMethod.get(member.exchange.request.method) ?? []),
        member,
      ])
    }
    for (const [method, group] of byMethod)
      operations.push(...templateOperations(method, group, names, isSecretKey))
  }
  return operations
}

/**
 * One operation per function of a dispatcher endpoint (decision 0039), at `<endpoint>#<value>`
 * like GraphQL operations on a shared endpoint (0027): the fragment is never sent, and the
 * generated client fills the dispatcher parameter in.
 */
function dispatchOperations(dispatcher: Dispatcher, members: Classified[], names: Map<number, string>, endpoint: string, isSecretKey: (key: string) => boolean): Operation[] {
  const byExchange = new Map(members.map(member => [member.exchange, member]))
  const values = dispatcher.groups.map(group => group.value)
  return dispatcher.groups.map(({ value, exchanges }) => {
    const group = exchanges.flatMap((exchange) => {
      const member = byExchange.get(exchange)
      return member
        ? [member]
        : []
    })
    const { method, host } = exchanges[0]!.request
    const dispatch: DispatchOperation = {
      endpoint,
      parameter: dispatcher.parameter,
      in: dispatcher.in,
      value,
      values,
    }
    return {
      ...emptyOperation({
        host,
        method,
        path: `${endpoint}#${value}`,
        kind: 'api',
        pathParams: pathParamsFor(group, names),
        summary: withResponseFields(`Function ${value} of ${method} ${endpoint} (${dispatcher.parameter}=${value}).`, exchanges, isSecretKey),
        exchanges,
        sourceOnly: false,
      }),
      dispatch,
    }
  })
}

/** The operation for a route found in code and never called. */
function sourceOnlyOperation(route: SourceRoute, host: string, template: ReturnType<typeof parseTemplate>): Operation {
  // The spec needs some method; `methodUnknown` marks it as a placeholder, not evidence.
  const method = (route.method ?? 'GET').toUpperCase()
  const names = new Map<number, string>()
  template.segments.forEach((part, index) => {
    if ('param' in part)
      names.set(index, camelCase(part.param) || `param${names.size + 1}`)
  })
  const segments = template.segments.map(part => 'literal' in part
    ? part.literal
    : '')
  const path = templateFor(segments, names)
  return emptyOperation({
    host,
    method,
    path,
    kind: 'api',
    pathParams: [...names].map(([index, name]) => ({
      name,
      index,
      schema: { type: 'string' },
      evidence: ['source-template'],
    })),
    summary: route.method === null
      ? `${capitalize(pathPhrase(path) || 'root')} (method unknown). Found in source code; not called during capture.`
      : `${capitalize(method.toLowerCase())} ${pathPhrase(path) || 'root'}. Found in source code; not called during capture.`,
    exchanges: [],
    sourceOnly: true,
    ...(route.method === null
      ? { methodUnknown: true }
      : {}),
  })
}

/** Hosts of the pages that loaded scripts from each script host, from the captured script requests. */
function pagesByScriptHost(exchanges: readonly Exchange[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const exchange of exchanges) {
    if (exchange.resourceType !== 'script' || exchange.pageUrl === null)
      continue
    let page: string
    try {
      page = new URL(exchange.pageUrl).host
    }
    catch {
      continue
    }
    result.set(exchange.request.host, (result.get(exchange.request.host) ?? new Set()).add(page))
  }
  return result
}

/**
 * Source routes never observed, and passed to a request call in the code, become `sourceOnly`
 * operations; a URL-like string alone is not evidence of an endpoint. A relative route belongs to
 * the page hosts that loaded the script it was found in (the browser resolves it against the
 * page), when the capture shows those; otherwise to the hosts that served pages, or to every
 * observed host when no page was captured.
 */
function sourceOnlyOperations(allRoutes: SourceRoute[], observed: Operation[], exchanges: readonly Exchange[]): Operation[] {
  const routes = allRoutes.filter(route => route.evidence === 'call')
  const scriptPages = pagesByScriptHost(exchanges)
  // A page answered with a challenge (every page, on a site that blocked the capture) is still
  // where the site's relative routes point.
  const servesPages = (operation: Operation): boolean => operation.kind === 'page'
    || operation.exchanges.some(exchange => exchange.resourceType === 'document' && isChallengeAnswer(exchange))
  const pageHosts = [
    ...new Set(observed.filter(servesPages).map(operation => operation.host)),
  ]
  const fallbackHosts = pageHosts.length > 0
    ? pageHosts
    : [
        ...new Set(observed.map(operation => operation.host)),
      ]
  const seen = new Set<string>()
  const result: Operation[] = []
  // Routes with a known method first, so a `fetch(url)` without a method never claims the slot
  // of a `POST` to the same path found elsewhere in the code.
  const ordered = [
    ...routes.filter(route => route.method !== null),
    ...routes.filter(route => route.method === null),
  ]
  for (const route of ordered) {
    const template = parseTemplate(route)
    const method = (route.method ?? 'GET').toUpperCase()
    const loadedBy = [
      ...new Set(route.scriptHosts.flatMap(host => [
        ...(scriptPages.get(host) ?? []),
      ])),
    ]
      .filter(host => fallbackHosts.includes(host))
      .sort()
    const relativeHosts = loadedBy.length > 0
      ? loadedBy
      : fallbackHosts
    for (const host of route.host === null
      ? relativeHosts
      : [route.host]) {
      const key = `${host} ${method} ${route.pathTemplate}`
      // A method-less route to a path the code also calls with a known method is that call.
      const anyMethod = `${host} * ${route.pathTemplate}`
      if (seen.has(key) || (route.method === null && seen.has(anyMethod)))
        continue
      seen.add(key)
      seen.add(anyMethod)
      const matched = observed.some(operation => operation.host === host
        && (route.method === null || operation.method === method)
        && templateMatches(template, segmentsOf(operation.graphql?.endpoint ?? operation.dispatch?.endpoint ?? operation.path)))
      if (matched)
        continue
      result.push(sourceOnlyOperation(route, host, template))
    }
  }
  return result
}

function baseOperationId(operation: Operation): string {
  if (operation.graphql)
    return graphqlOperationId(operation.graphql, operation.exchanges[0]?.graphql?.key ?? '')
  if (operation.dispatch)
    return dispatchOperationId(operation.dispatch)
  return operationIdFor(operation.method, operation.path)
}

/** `getSymbolData` for that value; empty when the value alone cannot name an operation. */
function dispatchOperationId(dispatch: DispatchOperation): string {
  const id = camelCase(dispatch.value)
  // A value such as `static`, `sdk` or `options` cannot name the client function on its own.
  return isUsableFunctionName(id)
    ? id
    : ''
}

/** The endpoint's id with the value after it: `getApiNextApiApiClientGetQuoteApiGetSymbolData`. */
function prefixedDispatchId(operation: Operation & { dispatch: DispatchOperation }): string {
  const value = camelCase(operation.dispatch.value)
  return `${operationIdFor(operation.method, operation.dispatch.endpoint)}${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function assignOperationIds(operations: Operation[]): Operation[] {
  const sorted = [...operations].sort((a, b) =>
    a.host.localeCompare(b.host)
    || a.path.localeCompare(b.path)
    || a.method.localeCompare(b.method)
    || Number(a.sourceOnly) - Number(b.sourceOnly))
  // A dispatcher function is named by its value unless another operation of the host would
  // take the same name; then it is prefixed with its endpoint, whatever the order.
  const bases = sorted.map(baseOperationId)
  const counts = new Map<string, number>()
  sorted.forEach((operation, index) => {
    const key = `${operation.host} ${bases[index]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })
  const used = new Map<string, Set<string>>()
  return sorted.map((operation, index) => {
    const ids = used.get(operation.host) ?? new Set<string>()
    used.set(operation.host, ids)
    const own = bases[index] ?? ''
    const base = operation.dispatch && (own === '' || (counts.get(`${operation.host} ${own}`) ?? 0) > 1)
      ? prefixedDispatchId({ ...operation, dispatch: operation.dispatch })
      : own
    let id = base
    for (let suffix = 2; ids.has(id); suffix++)
      id = `${base}${suffix}`
    ids.add(id)
    return { ...operation, operationId: id }
  })
}

/** `POST shop.test /graphql`: the endpoint a request went to, whatever operation it carried. */
function endpointKey(exchange: Exchange): string {
  return `${exchange.request.method} ${exchange.request.host} ${exchange.request.path}`
}

/**
 * The exchanges operations are built from, without challenge answers on endpoints that answered
 * other calls normally, and how many such answers each endpoint had. One batch of CodePen's
 * GraphQL that met a Cloudflare 403 must not become a `postGraphql` operation reported as browser
 * only while every other call to `/graphql` worked.
 */
function withoutStrayChallenges(exchanges: readonly Exchange[]): { kept: Exchange[], challenged: Map<string, number> } {
  const answered = new Set(exchanges
    .filter(exchange => (exchange.kind === 'api' || exchange.kind === 'page') && exchange.response.status > 0 && exchange.response.status < 400)
    .map(endpointKey))
  const challenged = new Map<string, number>()
  const kept = exchanges.filter((exchange) => {
    const key = endpointKey(exchange)
    if (!isChallengeAnswer(exchange) || !answered.has(key))
      return true
    challenged.set(key, (challenged.get(key) ?? 0) + 1)
    return false
  })
  return { kept, challenged }
}

/** The summary with a note when calls to the operation's endpoint were sometimes challenged. */
function withChallengeNote(operation: Operation, challenged: ReadonlyMap<string, number>): Operation {
  const count = [
    ...new Set(operation.exchanges.map(endpointKey)),
  ]
    .reduce((total, key) => total + (challenged.get(key) ?? 0), 0)
  return count === 0
    ? operation
    : { ...operation, summary: `${operation.summary} Sometimes challenged: ${count} call(s) to this endpoint got a bot challenge instead and are left out.` }
}

/**
 * Builds operations from classified exchanges (`api`, `page` and `bot-protection` only; challenge answers
 * on endpoints that answered other calls normally are left out) and adds
 * `sourceOnly` operations for source routes that were never called. Request and response shapes
 * are left empty for `analyze/schema`; `sentFrom` is left empty for the flows stage.
 *
 * @returns operations sorted by host, path, method
 */
export function buildOperations(exchanges: Exchange[], options: BuildOperationsOptions): Operation[] {
  const { kept, challenged } = withoutStrayChallenges(exchanges)
  const observed = [
    ...observedOperations(kept, options.sourceRoutes, options.isSecretKey, options.codeLiteral ?? (() => false)),
    ...graphqlOperations(kept.filter(exchange => OPERATION_KINDS.has(exchange.kind)), options.isSecretKey),
    ...rpcOperations(kept.filter(exchange => OPERATION_KINDS.has(exchange.kind)), options.isSecretKey),
  ].map(operation => withChallengeNote(operation, challenged))
  return assignOperationIds([
    ...observed,
    ...sourceOnlyOperations(options.sourceRoutes, observed, exchanges),
  ])
}
