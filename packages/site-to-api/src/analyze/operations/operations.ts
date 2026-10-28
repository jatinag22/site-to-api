/**
 * Groups exchanges into operations by host + method + path template.
 */
import type { Exchange, Operation, PathParam, SourceRoute } from '../../model'
import type { Evidence, Marks } from './templates'
import { isChallengeAnswer } from '../classify'
import { inferStringSchema } from '../schema'
import { isSlug } from './identifiers'
import { linkedSlugs } from './links'
import { camelCase, operationIdFor, pathPhrase, singular, words } from './naming'
import { markParameters, parseTemplate, segmentsOf, templateMatches } from './templates'

interface BuildOperationsOptions {
  /** Endpoints found in the site's code (from `analyze/source`); may be empty. */
  sourceRoutes: SourceRoute[]
}

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

/** Names the parameters of one structural path, shared by every method on that path. */
function nameParameters(members: Classified[]): Map<number, string> {
  const positions = [
    ...new Set(members.flatMap(member => [
      ...member.marks.keys(),
    ])),
  ].sort((a, b) => a - b)
  const names = new Map<number, string>()
  const used = new Set<string>()
  positions.forEach((index, ordinal) => {
    const sourceName = members.map(member => member.marks.get(index)?.sourceName).find(name => name)
    const previous = index > 0 && !positions.includes(index - 1)
      ? members[0]!.segments[index - 1]
      : undefined
    const values = members.map(member => member.segments[index] ?? '')
    let name: string
    if (sourceName) {
      name = camelCase(sourceName) || sourceName
    }
    else if (previous && words(previous).length > 0) {
      name = values.every(isSlug)
        ? 'slug'
        : `${camelCase(singular(previous))}Id`
    }
    else {
      name = `param${ordinal + 1}`
    }
    let unique = name
    for (let suffix = 2; used.has(unique); suffix++)
      unique = `${name}${suffix}`
    used.add(unique)
    names.set(index, unique)
  })
  return names
}

function responseFields(exchanges: Exchange[]): { list: boolean, fields: string[] } | null {
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
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value))
        fields.add(key)
    }
  }
  return fields.size === 0
    ? null
    : {
        list,
        fields: [...fields],
      }
}

function summarize(kind: OperationKind, method: string, path: string, exchanges: Exchange[]): string {
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
  const base = `${verb} ${phrase === ''
    ? 'root'
    : phrase}.`
  const response = responseFields(exchanges)
  if (!response)
    return base
  const shown = response.fields.slice(0, MAX_SUMMARY_FIELDS)
  const more = response.fields.length > shown.length
    ? `, +${response.fields.length - shown.length} more`
    : ''
  return `${base} Returns ${response.list ? 'a list of ' : ''}${shown.join(', ')}${more}.`
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
 * Operation kind of a group: `api` when any member is a data call, then `page`. A group is a
 * bot-protection step only when every member is: a page or API call that was challenged once
 * (`x-amzn-waf-action: challenge`, `cf-mitigated`) and then answered normally is still that page
 * or call, and must keep its client method.
 */
function kindOf(members: Classified[]): OperationKind {
  const kinds = new Set(members.map(member => member.exchange.kind))
  if (kinds.has('api'))
    return 'api'
  if (kinds.has('page'))
    return 'page'
  return 'bot-protection'
}

function capitalize(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

function emptyOperation(init: Pick<Operation, 'host' | 'method' | 'path' | 'kind' | 'pathParams' | 'summary' | 'exchanges' | 'sourceOnly' | 'methodUnknown'>): Operation {
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

function observedOperations(exchanges: Exchange[], routes: SourceRoute[]): Operation[] {
  const relevant = exchanges.filter(exchange => OPERATION_KINDS.has(exchange.kind))
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
    ], routesFor(routes, host, method), linkedSlugs(members, relevant))
    for (const exchange of members) {
      classified.push({
        exchange,
        segments: segmentsOf(exchange.request.path),
        marks: marks.get(exchange.request.path) ?? new Map(),
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
  for (const members of byStructure.values()) {
    const names = nameParameters(members)
    const byMethod = new Map<string, Classified[]>()
    for (const member of members) {
      byMethod.set(member.exchange.request.method, [
        ...(byMethod.get(member.exchange.request.method) ?? []),
        member,
      ])
    }
    for (const [method, group] of byMethod) {
      const path = templateFor(group[0]!.segments, names)
      const kind = kindOf(group)
      const groupExchanges = group.map(member => member.exchange)
      operations.push(emptyOperation({
        host: group[0]!.exchange.request.host,
        method,
        path,
        kind,
        pathParams: pathParamsFor(group, names),
        summary: summarize(kind, method, path, groupExchanges),
        exchanges: groupExchanges,
        sourceOnly: false,
      }))
    }
  }
  return operations
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
        && templateMatches(template, segmentsOf(operation.path)))
      if (matched)
        continue
      result.push(sourceOnlyOperation(route, host, template))
    }
  }
  return result
}

function assignOperationIds(operations: Operation[]): Operation[] {
  const sorted = [...operations].sort((a, b) =>
    a.host.localeCompare(b.host)
    || a.path.localeCompare(b.path)
    || a.method.localeCompare(b.method)
    || Number(a.sourceOnly) - Number(b.sourceOnly))
  const used = new Map<string, Set<string>>()
  return sorted.map((operation) => {
    const ids = used.get(operation.host) ?? new Set<string>()
    used.set(operation.host, ids)
    const base = operationIdFor(operation.method, operation.path)
    let id = base
    for (let suffix = 2; ids.has(id); suffix++)
      id = `${base}${suffix}`
    ids.add(id)
    return { ...operation, operationId: id }
  })
}

/**
 * Builds operations from classified exchanges (`api`, `page` and `bot-protection` only) and adds
 * `sourceOnly` operations for source routes that were never called. Request and response shapes
 * are left empty for `analyze/schema`; `sentFrom` is left empty for the flows stage.
 *
 * @returns operations sorted by host, path, method
 */
export function buildOperations(exchanges: Exchange[], options: BuildOperationsOptions): Operation[] {
  const observed = observedOperations(exchanges, options.sourceRoutes)
  return assignOperationIds([
    ...observed,
    ...sourceOnlyOperations(options.sourceRoutes, observed, exchanges),
  ])
}
