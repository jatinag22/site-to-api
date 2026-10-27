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
