/**
 * Result of analysing captured traffic. Every emitter (OpenAPI specs, flows, API_MAP.md,
 * AGENT.md) and the `gen` step reads from {@link Analysis}; none of them look at raw HAR data.
 */
import type { ExtractSpec } from '@site-to-api/runtime'
import type { Exchange, ExchangeKind } from './exchange'
import type { FlowsDocument, SourceRef } from './flows'

/** The subset of JSON Schema 2020-12 the inference stage produces. */
export interface JsonSchema {
  'type'?: JsonSchemaType | JsonSchemaType[]
  'properties'?: Record<string, JsonSchema>
  'required'?: string[]
  'items'?: JsonSchema
  'additionalProperties'?: boolean | JsonSchema
  'enum'?: Array<string | number | boolean | null>
  'const'?: string | number | boolean | null
  'format'?: string
  'pattern'?: string
  'minLength'?: number
  'maxLength'?: number
  'anyOf'?: JsonSchema[]
  'description'?: string
  'examples'?: unknown[]
  /** Extension: the value never changed across sessions. */
  'x-constant'?: boolean
}

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export interface PathParam {
  name: string
  /** Index of the path segment, counting from 0 after the leading slash. */
  index: number
  schema: JsonSchema
  /** Why it was treated as a parameter. */
  evidence: Array<'source-template' | 'value-trace' | 'varies' | 'looks-like-id'>
}

export interface ParamInfo {
  name: string
  required: boolean
  schema: JsonSchema
}

export interface HeaderInfo extends ParamInfo {
  /** Same value in every sample: the client can send it as a default. */
  constant: boolean
}

export interface ResponseInfo {
  status: number
  mimeType: string
  /** For JSON responses. */
  schema: JsonSchema | null
  /** For HTML or text responses that carry data. */
  extract: { spec: ExtractSpec, samples: number, confidence: 'high' | 'low' } | null
  /** Redacted examples, at most `config.redact.maxExamples`. */
  examples: unknown[]
}

export interface Operation {
  /** Stable, readable id, e.g. `getApiIpoDetail`. Unique per host. */
  operationId: string
  host: string
  method: string
  /** Path with parameters, e.g. `/api/ipo/{symbol}/bids`. */
  path: string
  kind: Exclude<ExchangeKind, 'asset' | 'noise'>
  pathParams: PathParam[]
  query: ParamInfo[]
  headers: HeaderInfo[]
  /** Cookies this operation was seen with. Names only. */
  cookies: ParamInfo[]
  requestBody: { mimeType: string, schema: JsonSchema, examples: unknown[] } | null
  responses: ResponseInfo[]
  /** Where the page's code sends this request from. */
  sentFrom: SourceRef[]
  /** True when the operation appears in source code but was never called during capture. */
  sourceOnly: boolean
  /** Short description without an LLM: trigger labels, path words, response field names. */
  summary: string
  exchanges: Exchange[]
}

export interface BotProtectionFinding {
  vendor: string
  host: string
  evidence: string
  exchangeIds: string[]
}

export interface Analysis {
  sessions: string[]
  hosts: string[]
  operations: Operation[]
  flows: FlowsDocument
  botProtection: BotProtectionFinding[]
  /** Source excerpts to write into the handoff folder, keyed by their path under `source/`. */
  excerpts: Map<string, string>
  warnings: string[]
}
