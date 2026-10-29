/**
 * Fixes the GraphQL fields of an operation's inferred request shapes (decision 0027). Within one
 * GraphQL operation the operation name, the persisted-query hash and the document never change,
 * so they become constants with a default the generated client sends itself; `variables` stays
 * the caller's input. Fields a site adds next to them are left optional, so the client only
 * ever has to fill in the variables. When the document was captured, its variable definitions
 * decide which variables are required (`$id: Int!` is, `$id: Int` is not); persisted queries
 * keep the evidence rule of the samples.
 */
import type { GraphqlOperation, JsonSchema, Operation, ParamInfo, ValueRedactor } from '../../model'
import { GRAPHQL_FIELDS } from './detect'
import { readVariables } from './document'

function constant(value: string | number, type: 'string' | 'integer'): JsonSchema {
  return { type, const: value, default: value }
}

/** `extensions` with the persisted query pinned; other extension fields stay as inferred, optional. */
function extensionsSchema(inferred: JsonSchema | undefined, persisted: NonNullable<GraphqlOperation['persistedQuery']>): JsonSchema {
  const persistedQuery: JsonSchema = {
    type: 'object',
    properties: {
      ...(persisted.version === null
        ? {}
        : {
            version: constant(persisted.version, 'integer'),
          }),
      sha256Hash: constant(persisted.sha256Hash, 'string'),
    },
    required: persisted.version === null
      ? ['sha256Hash']
      : ['version', 'sha256Hash'],
  }
  return {
    type: 'object',
    properties: {
      ...inferred?.properties,
      persistedQuery,
    },
    required: ['persistedQuery'],
  }
}

/** The pinned schema of one GraphQL field, or null when it stays as inferred. */
function pinned(field: string, inferred: JsonSchema | undefined, graphql: GraphqlOperation): JsonSchema | null {
  if (field === 'operationName' && graphql.operationName !== null)
    return constant(graphql.operationName, 'string')
  if (field === 'query' && graphql.document !== null)
    return constant(graphql.document, 'string')
  if (field === 'extensions' && graphql.persistedQuery !== null)
    return extensionsSchema(inferred, graphql.persistedQuery)
  return null
}

/** Fields the generated client sends: the pinned constants, plus `variables`. */
function clientSends(field: string, graphql: GraphqlOperation, sent: string[]): boolean {
  if (!sent.includes(field))
    return false
  return field === 'variables' || pinned(field, undefined, graphql) !== null
}

/** The declared non-null-ness of each variable, or null when no document says. */
function declaredVariables(graphql: GraphqlOperation): Map<string, boolean> | null {
  return graphql.document === null
    ? null
    : readVariables(graphql.document, graphql.operationName)
}

/**
 * `variables` with `required` taken from the document: every declared non-null variable the
 * samples show, and none declared nullable. Variables the document does not declare keep what
 * the samples said.
 */
function requireDeclared(schema: JsonSchema | undefined, declared: Map<string, boolean> | null): JsonSchema | undefined {
  if (schema?.properties === undefined || declared === null || declared.size === 0)
    return schema
  const inferred = new Set(schema.required ?? [])
  const required = Object.keys(schema.properties)
    .filter(name => declared.get(name) ?? inferred.has(name))
  const result: JsonSchema = { ...schema }
  delete result.required
  if (required.length > 0)
    result.required = required
  return result
}

function pinBody(schema: JsonSchema, graphql: GraphqlOperation, declared: Map<string, boolean> | null): JsonSchema {
  const properties: Record<string, JsonSchema> = { ...schema.properties }
  for (const field of GRAPHQL_FIELDS) {
    if (!graphql.sent.body.includes(field))
      continue
    const replacement = pinned(field, properties[field], graphql)
    if (replacement)
      properties[field] = replacement
  }
  const variables = requireDeclared(properties.variables, declared)
  if (variables !== undefined)
    properties.variables = variables
  // Required means "the client sends it": the pinned constants (which it fills in itself) and
  // `variables`, whenever every sample carried them. This does not depend on the inferred
  // `required`, which only lists fields with more than one value across samples (see analyze/schema).
  const required = Object.keys(properties).filter(field => clientSends(field, graphql, graphql.sent.body))
  const result: JsonSchema = { ...schema, properties }
  delete result.required
  if (required.length > 0)
    result.required = required
  return result
}

function pinQuery(params: ParamInfo[], graphql: GraphqlOperation, declared: Map<string, boolean> | null): ParamInfo[] {
  return params.map((param) => {
    if (!graphql.sent.query.includes(param.name))
      return param
    const replacement = param.name === 'variables'
      ? requireDeclared(param.schema, declared) ?? null
      : pinned(param.name, param.schema, graphql)
    return {
      ...param,
      required: param.required && clientSends(param.name, graphql, graphql.sent.query),
      ...(replacement
        ? { schema: replacement }
        : {}),
    }
  })
}

/**
 * Returns the operation with its GraphQL constants pinned and the query document redacted like
 * any other request value. Operations without `graphql` are returned unchanged.
 */
export function pinGraphqlSchemas(operation: Operation, redactor: ValueRedactor): Operation {
  if (!operation.graphql)
    return operation
  const graphql: GraphqlOperation = {
    ...operation.graphql,
    document: operation.graphql.document === null
      ? null
      : redactor.value(operation.graphql.document, { in: 'body', name: 'query' }),
  }
  // Read before redaction: masking a value inline must not hide a variable definition.
  const declared = declaredVariables(operation.graphql)
  const body = operation.requestBody
  return {
    ...operation,
    graphql,
    query: pinQuery(operation.query, graphql, declared),
    requestBody: body && body.schema.type === 'object'
      ? {
          ...body,
          schema: pinBody(body.schema, graphql, declared),
        }
      : body,
  }
}
