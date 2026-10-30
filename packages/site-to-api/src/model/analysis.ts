/**
 * Result of analysing captured traffic. Every emitter (OpenAPI specs, flows, API_MAP.md,
 * AGENT.md) and the `gen` step reads from {@link Analysis}; none of them look at raw HAR data.
 */
import type { ExtractSpec } from '@site-to-api/runtime'
import type { Exchange, ExchangeKind, GraphqlOperationType, RpcRequest } from './exchange'
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

/** The request body of an operation, typed by what the body is, not by what its header claims. */
export interface RequestBodyInfo {
  /** Media type of the body syntax: `application/json` whenever every captured body parsed as JSON. */
  mimeType: string
  /**
   * The `Content-Type` the site sent when it differs from `mimeType`: JSON text sent as
   * `application/x-www-form-urlencoded` or `text/plain` (common to avoid a CORS preflight).
   * Servers that do this often reject the same body under another type, so clients send it as is.
   */
  sentContentType?: string
  schema: JsonSchema
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

/**
 * What makes an operation one function of a dispatcher endpoint (decision 0039): one URL where a
 * parameter picks the function (`functionName=getSymbolData`, `action=heartbeat`, JSON-RPC
 * `method`). Each value gets its own operation, with `path` set to `<endpoint>#<value>`.
 */
export interface DispatchOperation {
  /** The real path the requests go to, e.g. `/api/NextApi/apiClient/GetQuoteApi`. */
  endpoint: string
  /** The dispatcher parameter, e.g. `functionName`. */
  parameter: string
  /** Where it is sent: the query string, a form field, or a top-level field of a JSON body. */
  in: 'query' | 'form' | 'json'
  /** The value this operation sends, e.g. `getSymbolData`. */
  value: string
  /** Every value the capture showed on the endpoint, sorted (the operation's siblings). */
  values: string[]
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
  requestBody: RequestBodyInfo | null
  responses: ResponseInfo[]
  /** Where the page's code sends this request from. */
  sentFrom: SourceRef[]
  /**
   * True when the page did send it, but only from code no capture can show: evaluated code
   * (`eval`, webpack's `webpack-internal:///5467` modules) or anonymous scripts. `sentFrom` is
   * then empty, and the output says "no source available" instead of a reference that leads nowhere.
   */
  sourceUnavailable?: boolean
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
  /** Set when the operation is one function of a dispatcher endpoint (decision 0039). */
  dispatch?: DispatchOperation
  /** Set when the operation is one tRPC procedure or Connect RPC method (decision 0051). */
  rpc?: RpcOperation
}

/** A tRPC procedure or Connect RPC method, one per operation (decision 0051). */
export interface RpcOperation {
  protocol: 'trpc' | 'connect'
  /** As in {@link RpcRequest.procedure}. */
  procedure: string
  /**
   * True when the method only reads: a tRPC query (sent with GET), a Connect method called with
   * GET, or one whose descriptor in the site's code says `idempotency_level = NO_SIDE_EFFECTS`.
   */
  readOnly: boolean
  /** Why `readOnly` is true (`called with GET`, `NO_SIDE_EFFECTS in the site's descriptor`); null when false. */
  readOnlyEvidence: string | null
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

/**
 * Framing protocols the channels stage decodes (decision 0038). `graphql-ws` covers both
 * `graphql-transport-ws` and the older `subscriptions-transport-ws` (see the channel's `version`).
 */
export type ChannelProtocolId = 'socket.io' | 'signalr' | 'stomp' | 'graphql-ws' | 'phoenix' | 'centrifugo' | 'sfs2x' | 'sse' | 'firebase' | 'primus'

/** How each protocol is called in prose. */
export const CHANNEL_PROTOCOL_LABELS: Readonly<Record<ChannelProtocolId, string>> = {
  'socket.io': 'Socket.IO',
  'signalr': 'SignalR',
  'stomp': 'STOMP',
  'graphql-ws': 'GraphQL over WebSocket',
  'phoenix': 'Phoenix',
  'centrifugo': 'Centrifugo',
  'sfs2x': 'SmartFoxServer 2X',
  'sse': 'server-sent events',
  'firebase': 'Firebase Realtime Database',
  'primus': 'Primus',
}

/**
 * What a client message does, from its protocol frame or the words of its name (decision 0030):
 * sets up the connection (`init`, `auth`, `subscribe`), tears it down (`unsubscribe`), keeps it
 * alive (`keepalive`) or carries data.
 */
export type MessageRole = 'init' | 'auth' | 'subscribe' | 'unsubscribe' | 'keepalive' | 'data'

/** How a message type was read from a framing protocol (decision 0038). */
export interface ChannelMessageProtocol {
  protocol: ChannelProtocolId
  /**
   * The protocol's frame type: `event`, `ack`, `connect`, `ping` (Socket.IO), `invocation`,
   * `completion` (SignalR), `SEND`, `MESSAGE` (STOMP), `subscribe`, `next` (graphql-ws), `push`
   * (Phoenix), `publication` (Centrifugo), `system`, `extension`, `encrypted` (SFS2X).
   */
  frame: string
  /**
   * The protocol-level name: the Socket.IO event, SignalR target, STOMP destination, GraphQL
   * operation or Phoenix `topic:event`. Identifiers in it are `{id}`; it is redacted.
   */
  name: string
  role: MessageRole
  /** The frame as it goes on the wire, with `<payload>` where the payload goes. Redacted. */
  wire: string
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
  /** Set when the frames were read with a framing protocol; then it names the message, not `discriminator`. */
  protocol: ChannelMessageProtocol | null
  /**
   * `json` for JSON text (or a protocol payload that is JSON), `text` for other text,
   * `msgpack` and `protobuf` for binary frames that decoded fully (decision 0038), `sfs2x` for
   * SmartFoxServer 2X packets (decision 0048), `binary` for the rest.
   */
  format: 'json' | 'text' | 'binary' | 'msgpack' | 'protobuf' | 'sfs2x'
  /** Frames seen across all connections. */
  count: number
  /**
   * Frames the JSON schema was inferred from: the first 1000 when there were more (`count`), so
   * a field only later frames have can be missing. Null for text and binary frames.
   */
  schemaSamples: number | null
  /** JSON Schema of the message, for JSON, MessagePack, protobuf and SFS2X messages; null otherwise. */
  schema: JsonSchema | null
  /** For text frames: value-free shape descriptions of the frames, most common first. */
  shapes: string[]
  /** Redacted examples, at most `config.redact.maxExamples`; empty for undecoded binary frames. */
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

/** The framing protocol of a channel and what showed it (decision 0038). */
export interface ChannelProtocol {
  id: ChannelProtocolId
  /**
   * `Engine.IO 3` / `Engine.IO 4` (Socket.IO), `graphql-transport-ws` / `subscriptions-transport-ws`
   * (graphql-ws), `json 1` (SignalR), `1.2` (STOMP), `2.0.0` (Phoenix), `client API 1.8.4`
   * (SFS2X); null when not shown.
   */
  version: string | null
  /** What showed it, e.g. `URL path ends in /socket.io/`, `subprotocol graphql-transport-ws`, `frames`. */
  evidence: string[]
  /** Set when the frames were wrapped in another framing, e.g. `sockjs`. */
  wrapper: 'sockjs' | null
}

/**
 * Facts about how connections to a channel were opened, from the upgrade request and the first
 * messages (decision 0038). Names only for cookies and URL tokens; every value is redacted.
 */
export interface ChannelConnectionFacts {
  /** `Origin` header values the browser sent on the upgrade request. */
  origins: string[]
  /** `Sec-WebSocket-Protocol` values the browser asked for and the server picked. */
  subprotocols: { requested: string[], selected: string[] }
  /** Query parameters of the connection URL that hold a secret or token (names only). */
  urlTokens: string[]
  /**
   * How the server answered the upgrade: accepted (101, or frames came back), rejected (another
   * status), unknown (no upgrade request in the HAR and no frame from the server).
   */
  upgrade: { accepted: number, rejected: number, unknown: number, statuses: number[] }
  /**
   * The first message that opened or authenticated the connection (the first `init` or `auth`
   * message), and the server's next message after it; the most common pair across connections.
   */
  firstMessage: { message: string, role: HandshakeRole, reply: string | null } | null
  /**
   * `websocket`, and `polling` when Engine.IO long-polling carried the same channel; `sse` for a
   * server-sent event stream (decision 0050), which is a channel of its own.
   */
  transports: Array<'websocket' | 'polling' | 'sse'>
}

/** A WebSocket endpoint seen during capture, with its messages grouped by direction and type. */
export interface WebSocketChannel {
  /** Unique per host and usable as an AsyncAPI key, e.g. `wsTicker`. */
  id: string
  host: string
  /** `ws` or `wss` for a WebSocket; `http` or `https` for a server-sent event stream (decision 0050). */
  scheme: 'ws' | 'wss' | 'http' | 'https'
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
  /** The framing protocol detected on the channel; null for plain JSON or text (decision 0038). */
  protocol: ChannelProtocol | null
  /** How connections were opened: origin, subprotocol, URL tokens, the server's answer. */
  connection: ChannelConnectionFacts
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
  /**
   * The URLs the capture sessions started at (`meta.json` `startUrl`), sorted, once each. When no
   * page was browsed (every navigation was answered by a script, or the capture had none), their
   * site is the site's own (decision 0050). Optional and additive.
   */
  startUrls?: string[]
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
