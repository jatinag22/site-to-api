/**
 * Result of analysing captured traffic. Every emitter (OpenAPI specs, flows, API_MAP.md,
 * AGENT.md) and the `gen` step reads from {@link Analysis}; none of them look at raw HAR data.
 */
import type { ExtractSpec } from '@site-to-api/runtime'
import type { Exchange, ExchangeKind, GraphqlOperationType } from './exchange'
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
  /**
   * The value is JSON text (GraphQL `variables` and `extensions` in a query string): `schema`
   * describes the decoded value, and OpenAPI gets `content: application/json` instead of `schema`.
   */
  json?: boolean
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

/** What makes an operation a GraphQL operation (decision 0027). */
export interface GraphqlOperation {
  /** The real path the requests go to, e.g. `/graphql`; `Operation.path` may add `#<name>`. */
  endpoint: string
  operationName: string | null
  operationType: GraphqlOperationType
  /**
   * Evidence for `operationType`: the captured `document`, `get` (GraphQL over HTTP allows only
   * queries over GET), `source` (the site's code names the type next to the persisted hash or
   * the name), or null when unknown.
   */
  operationTypeFrom: 'document' | 'get' | 'source' | null
  /** The persisted query of the most recent sample; null when none was sent. */
  persistedQuery: { version: number | null, sha256Hash: string } | null
  /** Every persisted hash seen, sorted; more than one means the site redeployed between captures. */
  hashes: string[]
  /** Query document as sent (redacted by the schema stage), or null for persisted queries. */
  document: string | null
  /** At least one sample was an element of a batched array body. */
  batched: boolean
  /** The GraphQL fields every sample carried, per location (`operationName`, `variables`, ...). */
  sent: { body: string[], query: string[] }
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
  /** Set when the operation is one GraphQL operation (decision 0027). */
  graphql?: GraphqlOperation
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
  /**
   * Frames the JSON schema was inferred from: the first 1000 when there were more (`count`), so
   * a field only later frames have can be missing. Null for text and binary frames.
   */
  schemaSamples: number | null
  /** JSON Schema of the message, for JSON messages; null otherwise. */
  schema: JsonSchema | null
  /** For text frames: value-free shape descriptions of the frames, most common first. */
  shapes: string[]
  /** Redacted examples, at most `config.redact.maxExamples`; empty for binary frames. */
  examples: unknown[]
  /** Values in this message traced to earlier HTTP responses or typing (client messages only). */
  links: ChannelValueLink[]
}

/**
 * Why a message is part of a channel's setup, from its type's name: `init` (`connection_init`,
 * `hello`), `auth` (`auth`, `login`), `subscribe` (`subscribe`, `join`); `other` when no message
 * type was recognised and the first message the client sent is listed instead.
 */
export type HandshakeRole = 'init' | 'auth' | 'subscribe' | 'other'

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
   * What the client sends to set up the connection (decision 0030), in order: the most common
   * setup sequence across connections, with the role of each message and a redacted example.
   */
  handshake: Array<{ message: string, role: HandshakeRole, example: unknown }>
  /**
   * Cookies on the HTTP upgrade request: `sent` (names listed), `none`, or `unknown` when the
   * HAR has no upgrade request for the channel.
   */
  cookies: { status: 'sent' | 'none' | 'unknown', names: string[] }
  /** Path and query values of the connection URL traced to earlier responses. */
  links: ChannelValueLink[]
  /**
   * Directions whose JSON messages come in several shapes but could not be grouped by type: no
   * field names the type, or the best one (`field`) has more `values` than a message type can.
   */
  ungrouped: Array<{ direction: ChannelMessage['direction'], field: string | null, values: number | null }>
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
