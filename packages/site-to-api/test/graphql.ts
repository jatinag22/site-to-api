/**
 * Hand-built GraphQL exchanges for tests: a POST to a shared endpoint, a GET persisted query
 * with JSON in the query string, and a batched POST. Every value is made up.
 */
import type { Analysis, Exchange } from '../src/model'
import { annotateGraphql } from '../src/analyze/graphql'
import { buildOperations } from '../src/analyze/operations'
import { createRedactor } from '../src/analyze/redact'
import { inferOperationSchemas } from '../src/analyze/schema'
import { buildOpenApiDocuments, toYaml } from '../src/emit/openapi'
import { FLOWS_FORMAT_VERSION } from '../src/model'
import { exchange, jsonBody } from './helpers'

/** A made-up SHA-256 persisted-query hash: 64 hex characters derived from `seed`. */
export function fakeHash(seed: string): string {
  return seed.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a')
}

export interface GraphqlPostInit {
  host?: string
  path?: string
  operationName?: string
  query?: string
  variables?: Record<string, unknown>
  hash?: string
  data?: unknown
  sessionId?: string
  startedAt?: number
}

/** POST `<path>` with a JSON GraphQL body, answering `{ data }`. */
export function graphqlPost(init: GraphqlPostInit): Exchange {
  const body: Record<string, unknown> = {}
  if (init.operationName !== undefined)
    body.operationName = init.operationName
  if (init.query !== undefined)
    body.query = init.query
  if (init.variables !== undefined)
    body.variables = init.variables
  if (init.hash !== undefined) {
    body.extensions = {
      persistedQuery: { version: 1, sha256Hash: init.hash },
    }
  }
  return exchange({
    method: 'POST',
    url: `https://${init.host ?? 'api.example.test'}${init.path ?? '/graphql'}`,
    requestBody: jsonBody(body),
    responseBody: jsonBody({ data: init.data ?? {} }),
    ...(init.sessionId === undefined
      ? {}
      : { sessionId: init.sessionId }),
    ...(init.startedAt === undefined
      ? {}
      : { startedAt: init.startedAt }),
  })
}

export interface GraphqlGetInit {
  host?: string
  path?: string
  operationName: string
  variables: Record<string, unknown>
  hash: string
  extraQuery?: Record<string, string>
  data?: unknown
  sessionId?: string
}

/** GET `<path>?operationName=&variables=<json>&extensions=<json>`, Airbnb-style. */
export function graphqlGet(init: GraphqlGetInit): Exchange {
  const params = new URLSearchParams({
    operationName: init.operationName,
    ...init.extraQuery,
    variables: JSON.stringify(init.variables),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: init.hash },
    }),
  })
  return exchange({
    url: `https://${init.host ?? 'api.example.test'}${init.path ?? '/graphql'}?${params.toString()}`,
    responseBody: jsonBody({ data: init.data ?? {} }),
    ...(init.sessionId === undefined
      ? {}
      : { sessionId: init.sessionId }),
  })
}

/** The analysis `build` would make of these exchanges on one host (no flows, no probe). */
export function graphqlAnalysis(exchanges: Exchange[], host: string): Analysis {
  const annotated = annotateGraphql(exchanges)
  const redactor = createRedactor({
    exchanges: annotated,
    config: {
      examples: 'masked',
      maxExamples: 2,
      patterns: [],
      fields: [],
    },
  })
  const operations = inferOperationSchemas(buildOperations(annotated, { sourceRoutes: [] }), redactor)
  const analysis: Analysis = {
    sessions: ['s1'],
    hosts: [host],
    operations,
    flows: {
      formatVersion: FLOWS_FORMAT_VERSION,
      generatedBy: 'test',
      sessions: ['s1'],
      session: [],
      flows: [],
      computedValues: [],
    },
    botProtection: [],
    excerpts: new Map(),
    warnings: [],
  }
  return analysis
}

/** What `build` would write as `specs/<host>.yaml` for these exchanges (no flows, no probe). */
export function graphqlSpecYaml(exchanges: Exchange[], host: string): string {
  return toYaml(buildOpenApiDocuments(graphqlAnalysis(exchanges, host)).get(host) ?? {})
}
