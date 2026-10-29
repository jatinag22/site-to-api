/**
 * Recognises GraphQL requests by their content (decision 0027): a JSON body or query string with
 * a query document, a persisted-query hash, or an operation name with variables, and the
 * `/<OperationName>/<sha256>` path some sites use. URL words such as `/graphql` are never
 * evidence on their own.
 */
import type { Exchange, GraphqlRequest, NameValue } from '../../model'
import { createHash } from 'node:crypto'
import { normalizeDocument, readOperations, selectOperation } from './document'
import { anonymousLabel } from './operation'

/** The request fields GraphQL over HTTP defines; anything else in a body is site-specific. */
export const GRAPHQL_FIELDS = [
  'extensions',
  'operationName',
  'query',
  'variables',
] as const

const SHA256 = /^[0-9a-f]{64}$/i
/** A GraphQL `Name` (spec 2.1.9). */
const GRAPHQL_NAME = /^[_A-Z]\w*$/i

type Fields = Partial<Record<(typeof GRAPHQL_FIELDS)[number], unknown>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

/** `extensions.persistedQuery` when it holds a SHA-256 hash (Apollo automatic persisted queries). */
function persistedQueryOf(extensions: unknown): GraphqlRequest['persistedQuery'] {
  if (!isRecord(extensions) || !isRecord(extensions.persistedQuery))
    return null
  const { sha256Hash, version } = extensions.persistedQuery
  if (typeof sha256Hash !== 'string' || !SHA256.test(sha256Hash))
    return null
  return {
    version: typeof version === 'number'
      ? version
      : null,
    sha256Hash,
  }
}

/** A GraphQL request without its location-specific parts, or null when `fields` is not one. */
function readFields(fields: Fields): Pick<GraphqlRequest, 'operationName' | 'document' | 'operationType' | 'persistedQuery'> | null {
  const document = typeof fields.query === 'string'
    ? fields.query
    : null
  const operations = document === null
    ? null
    : readOperations(document)
  const persistedQuery = persistedQueryOf(fields.extensions)
  // A `query` field that is not a GraphQL document (a search term) means this is not GraphQL,
  // unless a persisted-query hash says otherwise.
  if (document !== null && operations === null && persistedQuery === null)
    return null
  // Only a GraphQL name: anything else (`a?debug=1`, `{x}`) would end up in the spec path and URL.
  const declaredName = typeof fields.operationName === 'string' && GRAPHQL_NAME.test(fields.operationName)
    ? fields.operationName
    : null
  const hasVariables = 'variables' in fields && (fields.variables === null || isRecord(fields.variables))
  if (operations === null && persistedQuery === null && !(declaredName !== null && hasVariables))
    return null
  const selected = operations === null
    ? null
    : selectOperation(operations, declaredName)
  return {
    operationName: declaredName ?? selected?.name ?? null,
    document: operations === null
      ? null
      : document,
    operationType: selected?.type ?? 'unknown',
    persistedQuery,
  }
}

function sentFields(fields: Fields): string[] {
  return GRAPHQL_FIELDS.filter(name => fields[name] !== undefined)
}

function keyOf(request: Pick<GraphqlRequest, 'operationName' | 'document' | 'persistedQuery'>): string {
  if (request.operationName !== null)
    return request.operationName
  if (request.persistedQuery !== null)
    return `sha256:${request.persistedQuery.sha256Hash.toLowerCase()}`
  const normalized = normalizeDocument(request.document ?? '') ?? ''
  return `document:${createHash('sha256').update(normalized).digest('hex')}`
}

/**
 * The name of the GraphQL operation a request payload (`operationName`, `query`, `variables`,
 * `extensions`) runs, as the operations stage names it: the operation name, else
 * `persisted-<hash>` or `document-<hash>`. Null when the payload is not a GraphQL request. Used
 * for subscriptions sent over a WebSocket (decision 0038).
 */
export function graphqlOperationLabel(payload: Record<string, unknown>): string | null {
  const request = readFields(payload)
  return request === null
    ? null
    : request.operationName ?? anonymousLabel(keyOf(request))
}

/** `/<Name>/<sha256>` at the end of the path: the name and hash, or null. */
function pathOperation(path: string): { name: string, hash: string } | null {
  const segments = path.split('/').filter(segment => segment !== '')
  const hash = segments.at(-1)
  const name = segments.at(-2)
  if (hash === undefined || name === undefined || !SHA256.test(hash) || !GRAPHQL_NAME.test(name))
    return null
  return { name, hash }
}

/** Query-string fields, with `variables` and `extensions` decoded from their JSON text. */
function queryFields(query: NameValue[]): Fields {
  const fields: Fields = {}
  for (const name of GRAPHQL_FIELDS) {
    const value = query.find(item => item.name === name)?.value
    if (value === undefined)
      continue
    fields[name] = name === 'variables' || name === 'extensions'
      ? parseJson(value) ?? value
      : value
  }
  return fields
}

const RESPONSE_KEYS: ReadonlySet<string> = new Set(['data', 'errors', 'extensions'])

/** `errors` as GraphQL defines it: a list of objects that each have a string `message`. */
function isGraphqlErrors(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(item => isRecord(item) && typeof item.message === 'string')
}

/**
 * The response is shaped like a GraphQL response (only `data`, `errors` and `extensions`), and
 * says so beyond a `data` envelope that many REST APIs use too: either the request carried a
 * GraphQL field, or the response has GraphQL-shaped `errors`.
 */
function looksLikeGraphqlResponse(exchange: Exchange, requestHasGraphqlField: boolean): boolean {
  const json = exchange.response.body?.json
  if (!isRecord(json) || !('data' in json || 'errors' in json) || !Object.keys(json).every(key => RESPONSE_KEYS.has(key)))
    return false
  return requestHasGraphqlField || isGraphqlErrors(json.errors)
}

function finish(
  base: NonNullable<ReturnType<typeof readFields>>,
  exchange: Exchange,
  transport: GraphqlRequest['transport'],
  sent: GraphqlRequest['sent'],
  batchIndex: number | null,
): GraphqlRequest {
  const fromPath = batchIndex === null
    ? pathOperation(exchange.request.path)
    : null
  const pathNamesOperation = fromPath !== null
    && (base.operationName === null || base.operationName === fromPath.name)
    && (base.persistedQuery === null || base.persistedQuery.sha256Hash.toLowerCase() === fromPath.hash.toLowerCase())
  const request = {
    ...base,
    operationName: base.operationName ?? (pathNamesOperation
      ? fromPath.name
      : null),
    persistedQuery: base.persistedQuery ?? (pathNamesOperation
      ? { version: null, sha256Hash: fromPath.hash }
      : null),
  }
  return {
    ...request,
    key: keyOf(request),
    transport,
    sent,
    pathNamesOperation,
    batchIndex,
  }
}

function batchRequests(exchange: Exchange, json: unknown[]): GraphqlRequest[] | null {
  const items = json.map(item => isRecord(item)
    ? readFields(item)
    : null)
  if (!items.every(item => item !== null))
    return null
  return items.map((item, index) => {
    const element = json[index]
    return finish(item, exchange, 'body', {
      body: sentFields(isRecord(element)
        ? element
        : {}),
      query: [],
    }, index)
  })
}

/** A single request in a JSON body, or in the query string of a request without a body. */
function singleRequest(exchange: Exchange, json: unknown, query: Fields): GraphqlRequest | null {
  if (isRecord(json)) {
    const fields = readFields(json)
    return fields && finish(fields, exchange, 'body', {
      body: sentFields(json),
      query: sentFields(query),
    }, null)
  }
  if (exchange.request.body !== null && exchange.request.method !== 'GET')
    return null
  const fields = readFields(query)
  return fields && finish(fields, exchange, 'query', {
    body: [],
    query: sentFields(query),
  }, null)
}

/** The path names the operation and the response is GraphQL-shaped: still one operation. */
function pathRequest(exchange: Exchange, json: unknown, query: Fields): GraphqlRequest | null {
  const fromPath = pathOperation(exchange.request.path)
  const inBody = isRecord(json)
  const hasGraphqlField = sentFields(query).length > 0 || (inBody && sentFields(json).length > 0)
  if (fromPath === null || !looksLikeGraphqlResponse(exchange, hasGraphqlField))
    return null
  return finish({
    operationName: fromPath.name,
    document: null,
    operationType: 'unknown',
    persistedQuery: { version: null, sha256Hash: fromPath.hash },
  }, exchange, inBody
    ? 'body'
    : 'query', {
    body: inBody
      ? sentFields(json)
      : [],
    query: sentFields(query),
  }, null)
}

/**
 * The GraphQL requests an exchange carries: one for a single request, one per element for a
 * batched array body, null when it is not GraphQL.
 */
export function detectGraphqlRequests(exchange: Exchange): GraphqlRequest[] | null {
  const query = queryFields(exchange.request.query)
  const json = exchange.request.body?.json
  if (Array.isArray(json) && json.length > 0)
    return batchRequests(exchange, json)
  const request = singleRequest(exchange, json, query) ?? pathRequest(exchange, json, query)
  return request === null
    ? null
    : [request]
}
