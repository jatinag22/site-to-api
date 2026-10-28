/** GraphQL requests: detection, batch splitting, one operation per GraphQL operation (decision 0027). */
export { annotateGraphql } from './annotate'
export { applyGraphqlTypes, graphqlTypesInText, graphqlTypeTargets } from './evidence'
export type { GraphqlTypeTarget } from './evidence'
export { graphqlGroupKey, graphqlOperationId, graphqlOperationOf, graphqlSpecPath, graphqlSummary, isGraphqlExchange } from './operation'
export type { GraphqlExchange } from './operation'
export { pinGraphqlSchemas } from './schema'
