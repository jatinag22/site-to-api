/**
 * Pins the dispatcher parameter of a dispatcher function (decision 0039). Within one function
 * the parameter always has the same value, so it becomes a required constant with a default,
 * which the generated client sends itself; the function's other parameters stay as inferred.
 */
import type { DispatchOperation, JsonSchema, Operation } from '../../model'

function constant(value: string): JsonSchema {
  return { type: 'string', const: value, default: value }
}

function pinBody(schema: JsonSchema, dispatch: DispatchOperation): JsonSchema {
  const required = [
    ...new Set([
      ...(schema.required ?? []),
      dispatch.parameter,
    ]),
  ]
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [dispatch.parameter]: constant(dispatch.value),
    },
    required,
  }
}

/** Returns the operation with its dispatcher parameter pinned; others are returned unchanged. */
export function pinDispatchSchemas(operation: Operation): Operation {
  const { dispatch } = operation
  if (!dispatch)
    return operation
  if (dispatch.in === 'query') {
    return {
      ...operation,
      query: operation.query.map(param => param.name === dispatch.parameter
        ? {
            ...param,
            required: true,
            schema: constant(dispatch.value),
          }
        : param),
    }
  }
  const body = operation.requestBody
  return {
    ...operation,
    requestBody: body && body.schema.type === 'object'
      ? {
          ...body,
          schema: pinBody(body.schema, dispatch),
        }
      : body,
  }
}
