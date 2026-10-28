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
  /** Value a client can send when it has no other: set on constant headers (already redacted). */
  'default'?: string | number | boolean | null
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
  /**
   * True for a `sourceOnly` operation whose HTTP method the code did not reveal: `method` is then
   * a placeholder (`GET`), not evidence.
   */
  methodUnknown?: boolean
  /** From `probe`: cookies and headers the request needs (`cookie:sid`, `header:referer`). Absent when not probed. */
  requires?: string[] | null
  /** Short description without an LLM: trigger labels, path words, response field names. */
  summary: string
  exchanges: Exchange[]
}

/** Where a value that a WebSocket client sends came from (decision 0023). */
export type ChannelValueOrigin
  = | {
    kind: 'response'
    /** Operation whose response held the value. */
    operationId: string
    host: string
    /** Response location as in `flows.json`, e.g. `body./items/0/id`. Redacted. */
    output: string
    transform: 'none' | 'url-encoded' | 'base64' | 'json-string' | 'substring'
  }
  | {
    kind: 'html'
    operationId: string
    host: string
    /** CSS selector of the element; empty when the value is in the page but no rule was found. */
    selector: string
    attr: string | null
  }
  | { kind: 'user-input', field: string }

/** One traced input of a channel: a field of a client message, or a part of the connection URL. */
export interface ChannelValueLink {
  /** `body./productId` inside a message, `query.room` or `path.roomId` on the connection URL. */
  input: string
  origin: ChannelValueOrigin
  /** How many captured values were traced to this origin. */
  samples: number
}

/** A group of WebSocket messages that share a direction and a discriminator value. */
export interface ChannelMessage {
  /** Unique within the channel and usable as an AsyncAPI key: `sendSubscribe`, `receiveTick`. */
  id: string
  /** From the client's point of view: `send` is client → server, `receive` server → client. */
  direction: 'send' | 'receive'
  /**
   * The top-level field and value that tell this group apart (`type: tick`). Null when the
   * direction's JSON messages share no such field, and for text and binary frames.
   */
  discriminator: { field: string, value: string } | null
  format: 'json' | 'text' | 'binary'
  /** Frames seen across all connections. */
  count: number
  /** JSON Schema of the message, for JSON messages; null otherwise. */
  schema: JsonSchema | null
  /** For text frames: value-free shape descriptions of the frames, most common first. */
  shapes: string[]
  /** Redacted examples, at most `config.redact.maxExamples`; empty for binary frames. */
  examples: unknown[]
  /** Values in this message traced to earlier HTTP responses or typing (client messages only). */
  links: ChannelValueLink[]
}

/** A WebSocket endpoint seen during capture, with its messages grouped by direction and type. */
export interface WebSocketChannel {
  /** Unique per host and usable as an AsyncAPI key, e.g. `wsTicker`. */
  id: string
  host: string
  scheme: 'ws' | 'wss'
  /** Connection path with parameters, templated by the same rules as HTTP paths. */
  path: string
  pathParams: PathParam[]
  query: ParamInfo[]
  /** Connections opened during capture, across all sessions. */
  connections: number
  /** Where the page's code opens the socket, when the capture recorded a stack for it. */
  sentFrom: SourceRef | null
  messages: ChannelMessage[]
  /**
   * What the client sends right after connecting (subscription, authentication), in order: the
   * most common opening sequence across connections, with a redacted example of each message.
   */
  handshake: Array<{ message: string, example: unknown }>
  /**
   * Cookies on the HTTP upgrade request: `sent` (names listed), `none`, or `unknown` when the
   * HAR has no upgrade request for the channel.
   */
  cookies: { status: 'sent' | 'none' | 'unknown', names: string[] }
  /** Path and query values of the connection URL traced to earlier responses. */
  links: ChannelValueLink[]
  /** One-line description built from the path and the message names, without an LLM. */
  summary: string
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
  /** WebSocket channels, sorted by host then path. Absent when the build did not look at them. */
  channels?: WebSocketChannel[]
  /** Source excerpts to write into the handoff folder, keyed by their path under `source/`. */
  excerpts: Map<string, string>
  warnings: string[]
}
