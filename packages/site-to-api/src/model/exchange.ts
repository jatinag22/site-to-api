/**
 * In-memory model of captured traffic. `build` loads raw sessions into {@link Exchange}s and
 * every analysis stage works on these, never on HAR JSON directly.
 */
import type { StackFrame } from './capture'

export interface NameValue {
  name: string
  value: string
}

export interface Body {
  /** Lower-cased media type without parameters, e.g. `application/json`. */
  mimeType: string
  /** Decoded text. Absent for binary bodies. */
  text: string | null
  /** Base64 for binary bodies. */
  base64: string | null
  /** Parsed value when the body is JSON (including JSON sent with a wrong content type). */
  json: unknown
  /** Fields when the body is `application/x-www-form-urlencoded` or `multipart/form-data`. */
  form: NameValue[] | null
}

export interface SetCookie {
  name: string
  value: string
  domain: string | null
  path: string | null
  expires: string | null
  httpOnly: boolean
  secure: boolean
  sameSite: string | null
}

/** What started a request, taken from the instrumentation events. */
export interface Initiator {
  via: 'fetch' | 'xhr' | 'beacon' | 'form' | 'navigation' | 'other'
  stack: StackFrame[]
}

export type ExchangeKind = 'api' | 'page' | 'bot-protection' | 'asset' | 'noise'

/** GraphQL operation types, plus `unknown` when nothing in the capture shows which one it is. */
export type GraphqlOperationType = 'query' | 'mutation' | 'subscription' | 'unknown'

/**
 * One GraphQL request found in an exchange by `analyze/graphql` (decision 0027). A batched body
 * becomes one stand-in exchange per element, so each exchange carries at most one of these.
 */
export interface GraphqlRequest {
  /** `operationName` of the request, or the name a `/<Name>/<sha256>` path carries. */
  operationName: string | null
  /** The query document, when the request sent one. */
  document: string | null
  /** Operation type read from the document; `unknown` without one (GET implies `query`). */
  operationType: GraphqlOperationType
  /** `extensions.persistedQuery` (Apollo automatic persisted queries) or the path's hash. */
  persistedQuery: { version: number | null, sha256Hash: string } | null
  /**
   * Stable grouping key within an endpoint: the operation name, else `sha256:<persisted hash>`,
   * else `document:<sha256 of the whitespace-normalised document>`.
   */
  key: string
  /** Where the GraphQL fields were sent: the JSON body (POST) or the query string (GET). */
  transport: 'body' | 'query'
  /** The GraphQL fields the request carried, per location, sorted. */
  sent: { body: string[], query: string[] }
  /** The path ends in `/<operationName>/<sha256>`: the path names the operation. */
  pathNamesOperation: boolean
  /** Position in a batched (array) body, or null for a single request. */
  batchIndex: number | null
}

export interface Exchange {
  /** Stable id: `<sessionId>:<index in HAR>`. */
  id: string
  sessionId: string
  /** Position within its session, starting at 0. */
  seq: number
  /** Milliseconds since epoch. */
  startedAt: number
  /** Playwright's resource type (`document`, `xhr`, `fetch`, `script`, ...). */
  resourceType: string
  /** URL of the page that was open when the request was sent. */
  pageUrl: string | null
  request: {
    method: string
    url: string
    host: string
    path: string
    query: NameValue[]
    /** Header names lower-cased, HTTP/2 pseudo headers removed, `cookie` kept separately. */
    headers: NameValue[]
    cookies: NameValue[]
    body: Body | null
  }
  response: {
    status: number
    statusText: string
    headers: NameValue[]
    setCookies: SetCookie[]
    body: Body | null
  }
  initiator: Initiator | null
  /** Filled in by the classify stage. */
  kind: ExchangeKind
  /** Filled in by `analyze/graphql` when the request is a GraphQL request (decision 0027). */
  graphql?: GraphqlRequest
  /** Why the classifier chose `kind`, for debugging and the `--explain` output. */
  kindReason: string
}

/** Where a value sits inside an exchange. Used by value tracing, redaction and flows. */
export type ValueLocation
  = | { in: 'path', index: number }
    | { in: 'query', name: string }
    | { in: 'header', name: string }
    | { in: 'cookie', name: string }
    /** JSON Pointer (RFC 6901) into a JSON body, e.g. `/data/0/symbol`. */
    | { in: 'body', pointer: string }
    | { in: 'form', name: string }
    | { in: 'set-cookie', name: string }
    | { in: 'response-header', name: string }
    /** A value inside an HTML or text response; see `analyze/html`. */
    | { in: 'html', selector: string, attr: string | null, pattern: string | null }
