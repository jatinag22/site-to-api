/**
 * Fixes the GraphQL fields of an operation's inferred request shapes (decision 0027). Within one
 * GraphQL operation the operation name, the persisted-query hash and the document never change,
 * so they become constants with a default the generated client sends itself; `variables` stays
 * the caller's input. Fields a site adds next to them are left optional, so the client only
 * ever has to fill in the variables.
 */
import type { GraphqlOperation, JsonSchema, Operation, ParamInfo, ValueRedactor } from '../../model'
import { GRAPHQL_FIELDS } from './detect'

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

function pinBody(schema: JsonSchema, graphql: GraphqlOperation): JsonSchema {
  const properties: Record<string, JsonSchema> = { ...schema.properties }
  for (const field of GRAPHQL_FIELDS) {
    if (!graphql.sent.body.includes(field))
      continue
    const replacement = pinned(field, properties[field], graphql)
    if (replacement)
      properties[field] = replacement
  }
  const required = (schema.required ?? []).filter(field => clientSends(field, graphql, graphql.sent.body))
  const result: JsonSchema = { ...schema, properties }
  delete result.required
  if (required.length > 0)
    result.required = required
  return result
}

function pinQuery(params: ParamInfo[], graphql: GraphqlOperation): ParamInfo[] {
  return params.map((param) => {
    if (!graphql.sent.query.includes(param.name))
      return param
    const replacement = pinned(param.name, param.schema, graphql)
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
  const body = operation.requestBody
  return {
    ...operation,
    graphql,
    query: pinQuery(operation.query, graphql),
    requestBody: body && body.schema.type === 'object'
      ? {
          ...body,
          schema: pinBody(body.schema, graphql),
        }
      : body,
  }
}
