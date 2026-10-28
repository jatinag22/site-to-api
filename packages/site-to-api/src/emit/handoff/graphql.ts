/**
 * The GraphQL parts of `AGENT.md` ("GraphQL operations") and `API_MAP.md` (a table per endpoint),
 * decision 0027. Operation names, documents and variable names come from the captured site, so
 * each goes through `text()`, `code()` or `cellCode()` (decision 0019).
 */
import type { Analysis, GraphqlOperation, JsonSchema, Operation } from '../../model'
import { cellCode, code, text } from '../escape'
import { sdkFunctionName } from '../naming'

type GraphqlEntry = Operation & { graphql: GraphqlOperation }

/** Variables shown per operation; the spec has the rest. */
const MAX_VARIABLES = 8

const TYPE_FROM: Record<NonNullable<GraphqlOperation['operationTypeFrom']>, string> = {
  document: 'from the query document',
  get: 'sent with GET, which GraphQL allows for queries only',
  source: 'named in the site\'s code',
}

function isGraphql(operation: Operation): operation is GraphqlEntry {
  return operation.graphql !== undefined
}

/** Endpoints (`POST host/path`) with their operations, sorted by endpoint then operation id. */
function byEndpoint(analysis: Analysis): Array<[string, GraphqlEntry[]]> {
  const groups = new Map<string, GraphqlEntry[]>()
  for (const operation of analysis.operations.filter(isGraphql)) {
    const key = `${operation.method} ${operation.host}${operation.graphql.endpoint}`
    groups.set(key, [
      ...(groups.get(key) ?? []),
      operation,
    ])
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, operations]) => [
      key,
      operations.sort((a, b) => a.operationId.localeCompare(b.operationId)),
    ])
}

/** The `variables` schema: in the JSON body, or decoded from the query string. */
function variablesSchema(operation: Operation): JsonSchema | null {
  const fromBody = operation.requestBody?.schema.properties?.variables
  if (fromBody)
    return fromBody
  return operation.query.find(param => param.name === 'variables' && param.json === true)?.schema ?? null
}

function typeName(schema: JsonSchema): string {
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type === undefined
      ? []
      : [schema.type]
  if (types.length === 0)
    return schema.anyOf ? 'mixed' : 'unknown'
  return types.map(type => type === 'array' && schema.items
    ? `${typeName(schema.items)}[]`
    : type).join(' | ')
}

/** `id: string`, `first?: integer`, ... for the top-level variables; empty when there are none. */
function variableList(operation: Operation): string[] {
  const schema = variablesSchema(operation)
  const properties = Object.entries(schema?.properties ?? {})
  const required = new Set(schema?.required ?? [])
  const shown = properties.slice(0, MAX_VARIABLES).map(([name, child]) => `${name}${required.has(name)
    ? ''
    : '?'}: ${typeName(child)}`)
  return properties.length > shown.length
    ? [...shown, `+${properties.length - shown.length} more`]
    : shown
}

function clientCall(operation: GraphqlEntry): string {
  return `sdk.${sdkFunctionName(operation.operationId)}(${variablesSchema(operation) === null
    ? '{}'
    : '{ variables }'})`
}

function typeText(graphql: GraphqlOperation): string {
  if (graphql.operationTypeFrom === null)
    return 'type unknown (no query document, and the site\'s code did not say), so `probe` skips it unless `--unsafe-methods`'
  return `${graphql.operationType} (${TYPE_FROM[graphql.operationTypeFrom]})`
}

function hashText(graphql: GraphqlOperation, render: (value: string) => string): string {
  if (graphql.persistedQuery === null) {
    return graphql.document === null
      ? 'no persisted hash'
      : 'sends the query document'
  }
  const others = graphql.hashes.filter(hash => hash !== graphql.persistedQuery?.sha256Hash)
  return `persisted query ${render(graphql.persistedQuery.sha256Hash)}${others.length > 0
    ? ` (also seen: ${others.map(render).join(', ')}; the site redeployed between captures)`
    : ''}`
}

function agentLine(operation: GraphqlEntry): string {
  const { graphql } = operation
  const name = graphql.operationName ?? operation.operationId
  const variables = variableList(operation)
  const parts = [
    typeText(graphql),
    hashText(graphql, code),
    variables.length > 0
      ? `variables ${variables.map(code).join(', ')}`
      : 'no variables',
    ...(graphql.batched
      ? ['captured inside a batched request; the client sends it on its own']
      : []),
  ]
  return `- ${code(name)}: ${parts.join(', ')}. Client: ${code(clientCall(operation))}; spec path ${code(operation.path)}.`
}

/** The "GraphQL operations" section of `AGENT.md`; empty when the capture has none. */
export function graphqlSection(analysis: Analysis): string[] {
  const groups = byEndpoint(analysis)
  if (groups.length === 0)
    return []
  const lines = [
    '## GraphQL operations',
    '',
    'These requests are GraphQL. Each GraphQL operation is its own operation in the spec (marked',
    '`x-site-to-api-graphql`; the path is `<endpoint>#<name>` when operations share an endpoint) and',
    'its own client function, which sends the operation name, the persisted-query hash or the',
    'document itself: pass only `variables`. `probe` replays queries and skips mutations,',
    'subscriptions and operations of unknown type.',
    '',
  ]
  for (const [endpoint, operations] of groups)
    lines.push(`### ${code(endpoint)}`, '', ...operations.map(agentLine), '')
  return lines
}

/** The GraphQL tables of `API_MAP.md`, one per endpoint; empty when the capture has none. */
export function graphqlTables(analysis: Analysis): string[] {
  const groups = byEndpoint(analysis)
  if (groups.length === 0)
    return []
  const lines = [
    '## GraphQL operations',
    '',
    'One table per GraphQL endpoint; each row is also a row of its host table above.',
    '',
  ]
  for (const [endpoint, operations] of groups) {
    lines.push(
      `### ${text(endpoint)}`,
      '',
      '| Operation | Type | Persisted hash | Variables | Client |',
      '|---|---|---|---|---|',
      ...operations.map((operation) => {
        const { graphql } = operation
        const cells = [
          cellCode(graphql.operationName ?? operation.operationId),
          graphql.operationTypeFrom === null
            ? 'unknown'
            : `${graphql.operationType} (${text(TYPE_FROM[graphql.operationTypeFrom])})`,
          graphql.persistedQuery === null
            ? (graphql.document === null
                ? ''
                : 'none, sends the document')
            : cellCode(graphql.persistedQuery.sha256Hash),
          variableList(operation).map(cellCode).join(', '),
          cellCode(clientCall(operation)),
        ]
        return `| ${cells.join(' | ')} |`
      }),
      '',
    )
  }
  return lines
}

/** `api (GraphQL query)` for the Kind column of a host table. */
export function graphqlKind(operation: Operation): string | null {
  return operation.graphql
    ? `${operation.kind} (GraphQL ${operation.graphql.operationType === 'unknown'
      ? 'operation, type unknown'
      : operation.graphql.operationType})`
    : null
}

/** The Client cell of a GraphQL row: the `{ variables }` function. */
export function graphqlClientCall(operation: Operation): string | null {
  return isGraphql(operation)
    ? clientCall(operation)
    : null
}
