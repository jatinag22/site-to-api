/**
 * Interfaces between analysis stages that are built separately. A stage depends on these types,
 * never on another stage's implementation, so each can be tested with small fakes.
 */
import type { CaptureEvent, SessionMeta, StackFrame } from './capture'
import type { ValueLocation } from './exchange'
import type { SourceRef } from './flows'

/** A raw session after `load`. */
export interface LoadedSession {
  meta: SessionMeta
  /** Absolute path of the session directory. */
  dir: string
  events: CaptureEvent[]
}

/** Maps browser stack frames to source locations (implemented in `analyze/source`). */
export interface SourceResolver {
  /** Maps one frame through the session's sourcemaps; falls back to the bundle location. */
  resolve: (frame: StackFrame, sessionId: string) => SourceRef
  /**
   * The frame that best represents "the site's code that made this call": skips the tool's own
   * instrumentation, browser internals and third-party library code (`node_modules`, known
   * HTTP clients such as axios), then resolves it.
   */
  callSite: (stack: StackFrame[], sessionId: string) => SourceRef | null
}

/** An endpoint string found in the site's source code. */
export interface SourceRoute {
  /** `null` when the method could not be determined. */
  method: string | null
  /** `null` for relative URLs. */
  host: string | null
  /** Path with `{name}` placeholders where the code interpolates values, e.g. `/api/ipo/{symbol}`. */
  pathTemplate: string
  /** Placeholder names in order, taken from the interpolated variable names. */
  params: string[]
  ref: SourceRef
  /**
   * `call`: passed to a request call (`fetch`, `axios`, `xhr.open`, a request-named function).
   * `string`: only seen as a URL-like string or `new URL(...)`. Only a call is evidence enough
   * for an operation nobody saw being called; a string still helps name path parameters.
   */
  evidence: 'call' | 'string'
  /** Hosts of the scripts the route was found in, sorted; relative routes belong to their pages. */
  scriptHosts: string[]
  /** True when every script it was found in is a bot-protection script (Kasada `ips.js`, AWS WAF `challenge.js`). */
  onlyInBotProtectionScripts: boolean
}

/** Finds where a value appears inside an HTML or text document (implemented in `analyze/html`). */
export type HtmlLocator = (document: string, value: string) => {
  selector: string
  attr: string | null
  pattern: string | null
} | null

/** One request value and where it came from, produced by `analyze/correlate`. */
export interface ValueTrace {
  exchangeId: string
  location: ValueLocation
  /** The value as sent. Kept in memory only; emitters redact before writing. */
  value: string
  origin:
    | {
      kind: 'response'
      exchangeId: string
      location: ValueLocation
      transform: 'none' | 'url-encoded' | 'base64' | 'json-string' | 'substring'
    }
    | { kind: 'transform', eventIndex: number, sessionId: string }
    | { kind: 'user-input', field: string }
    | { kind: 'constant' }
    | { kind: 'browser', note: string }
    | { kind: 'unknown' }
}

/** Where a value being redacted sits. The name decides whether it is a secret (`authorization`). */
export interface RedactContext {
  in: 'path' | 'query' | 'header' | 'cookie' | 'set-cookie' | 'body' | 'form' | 'response-header' | 'response-body' | 'text'
  /** Parameter, header, cookie or field name; for JSON the nearest property name. */
  name?: string | null
}

/** Redacts the values of one kind of traffic (see {@link Redactor}). */
export interface ValueRedactor {
  /** Redacts one string value, including values nested in JSON strings and URL-encoded text. */
  value: (raw: string, context: RedactContext) => string
  /** Redacts every string (and personal-data number) inside a JSON value; returns a copy. */
  json: (value: unknown, context: RedactContext) => unknown
  /** Redacted, de-duplicated examples, at most `redact.maxExamples`; empty when examples are `none`. */
  examples: (values: unknown[], context: RedactContext) => unknown[]
  /**
   * Whether a JSON object key is itself a secret or personal value (a session token, a JWT, an
   * email, a learnt cookie value), so the object is a map keyed by data, not a record with named
   * fields. `json` and `examples` replace such keys by their shape; schemas describe the object
   * with `additionalProperties`. Ordinary keys are never secret. Independent of `examples`.
   */
  isSecretKey: (key: string) => boolean
}

/**
 * Applies `config.redact` to values before they are written to the handoff folder
 * (implemented in `analyze/redact`, decisions 0004 and 0008).
 */
export interface Redactor extends ValueRedactor {
  /**
   * Redacts large free text (code excerpts) where it stands: learnt secrets in every form, JWTs
   * and personal data are replaced, and nothing else changes; the text is never decoded, parsed
   * or re-encoded.
   */
  text: (text: string) => string
  /**
   * For bot-protection steps: every string and number becomes its shape (challenge inputs,
   * solutions, sensor data), since nothing in them is for a client to reuse. Still copies
   * values with `examples: raw` and writes none with `none`.
   */
  browserOnly: ValueRedactor
}
