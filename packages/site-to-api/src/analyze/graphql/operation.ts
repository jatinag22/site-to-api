/**
 * Per-operation facts of GraphQL exchanges (decision 0027): which exchanges form one operation,
 * the spec path that keeps operations sharing one endpoint apart, the operation id and the
 * `graphql` record the later stages and emitters read.
 */
import type { Exchange, GraphqlOperation, GraphqlRequest } from '../../model'
import { camelCase } from '../operations/naming'

export type GraphqlExchange = Exchange & { graphql: GraphqlRequest }

export function isGraphqlExchange(exchange: Exchange): exchange is GraphqlExchange {
  return exchange.graphql !== undefined
}

/** The path without a trailing `/<sha256>` when the path names the operation, so redeploys group together. */
function stablePath(exchange: GraphqlExchange): string {
  if (!exchange.graphql.pathNamesOperation)
    return exchange.request.path
  return exchange.request.path.replace(/\/[0-9a-f]{64}\/?$/i, '')
}

/** Grouping key: one operation per host, method, endpoint and GraphQL operation. */
export function graphqlGroupKey(exchange: GraphqlExchange): string {
  return `${exchange.request.host} ${exchange.request.method} ${stablePath(exchange)} ${exchange.graphql.key}`
}

function chronological(exchanges: readonly GraphqlExchange[]): GraphqlExchange[] {
  return [...exchanges].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

function intersection(lists: string[][]): string[] {
  const [first, ...rest] = lists
  return (first ?? []).filter(item => rest.every(list => list.includes(item)))
}

/** The operation type with the strongest evidence: a captured document, then GET. */
function operationTypeOf(exchanges: GraphqlExchange[]): Pick<GraphqlOperation, 'operationType' | 'operationTypeFrom'> {
  const fromDocuments = new Set(exchanges.map(exchange => exchange.graphql.operationType).filter(type => type !== 'unknown'))
  if (fromDocuments.size === 1) {
    const [type] = fromDocuments
    if (type !== undefined)
      return { operationType: type, operationTypeFrom: 'document' }
  }
  if (fromDocuments.size === 0 && exchanges.every(exchange => exchange.request.method === 'GET'))
    return { operationType: 'query', operationTypeFrom: 'get' }
  return { operationType: 'unknown', operationTypeFrom: null }
}

/**
 * The `graphql` record of one operation from its exchanges (all with the same group key). The
 * most recent sample decides the endpoint, document and persisted query.
 */
export function graphqlOperationOf(exchanges: readonly [GraphqlExchange, ...GraphqlExchange[]]): GraphqlOperation {
  const ordered = chronological(exchanges)
  const latest = ordered.at(-1) ?? exchanges[0]
  const latestWith = <T>(pick: (request: GraphqlRequest) => T | null): T | null =>
    ordered.map(exchange => pick(exchange.graphql)).filter(value => value !== null).at(-1) ?? null
  return {
    endpoint: latest.request.path,
    operationName: latest.graphql.operationName,
    ...operationTypeOf(ordered),
    persistedQuery: latestWith(request => request.persistedQuery),
    hashes: [
      ...new Set(ordered.flatMap(exchange => exchange.graphql.persistedQuery
        ? [exchange.graphql.persistedQuery.sha256Hash]
        : [])),
    ].sort(),
    document: latestWith(request => request.document),
    batched: ordered.some(exchange => exchange.graphql.batchIndex !== null),
    sent: {
      body: intersection(ordered.map(exchange => exchange.graphql.sent.body)),
      query: intersection(ordered.map(exchange => exchange.graphql.sent.query)),
    },
  }
}

/** A short, stable label for an operation without a name: the start of its hash or key. */
/** `persisted-<hash>` or `document-<hash>`: what an operation without a name is called. */
export function anonymousLabel(key: string): string {
  const [kind, hash = ''] = key.split(':')
  return `${kind === 'sha256'
    ? 'persisted'
    : 'document'}-${hash.slice(0, 12)}`
}

/**
 * The spec path: the endpoint itself when the path names the operation (`/api/v3/Name/<hash>`),
 * otherwise `<endpoint>#<name>`. OpenAPI needs one path item per operation and method, and a
 * URL fragment is never sent, so tools that ignore the extension still reach the endpoint.
 */
export function graphqlSpecPath(operation: GraphqlOperation, key: string, pathNamesOperation: boolean): string {
  if (pathNamesOperation)
    return operation.endpoint
  return `${operation.endpoint}#${operation.operationName ?? anonymousLabel(key)}`
}

/** `queryArtistOverview` for that operation name; `graphqlPersistedAb12…` without a name. */
export function graphqlOperationId(operation: GraphqlOperation, key: string): string {
  const fromName = operation.operationName === null
    ? ''
    : camelCase(operation.operationName)
  return fromName === ''
    ? camelCase(`graphql ${anonymousLabel(key)}`)
    : fromName
}

/**
 * The fields of `data` in successful responses, for the summary. A key that is a secret or
 * personal value (decision 0042) is written `{key}`.
 */
function dataFields(exchanges: Exchange[], isSecretKey: (key: string) => boolean): string[] {
  const fields = new Set<string>()
  for (const exchange of exchanges) {
    const json = exchange.response.body?.json
    if (json === null || typeof json !== 'object' || Array.isArray(json) || !('data' in json))
      continue
    const data: unknown = json.data
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      for (const key of Object.keys(data)) {
        fields.add(isSecretKey(key)
          ? '{key}'
          : key)
      }
    }
  }
  return [...fields]
}

const MAX_SUMMARY_FIELDS = 8

/** `GraphQL query queryArtistOverview (POST /pathfinder/v2/query). Returns artistUnion.` */
export function graphqlSummary(operation: GraphqlOperation, method: string, exchanges: Exchange[], isSecretKey: (key: string) => boolean): string {
  const type = operation.operationType === 'unknown'
    ? 'operation'
    : operation.operationType
  const name = operation.operationName === null
    ? ''
    : ` ${operation.operationName}`
  const base = `GraphQL ${type}${name} (${method} ${operation.endpoint}).`
  const fields = dataFields(exchanges, isSecretKey)
  if (fields.length === 0)
    return base
  const shown = fields.slice(0, MAX_SUMMARY_FIELDS)
  const more = fields.length > shown.length
    ? `, +${fields.length - shown.length} more`
    : ''
  return `${base} Returns ${shown.join(', ')}${more}.`
}
