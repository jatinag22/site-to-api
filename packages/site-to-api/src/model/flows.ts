/**
 * `flows.json`: the source of truth for how a site's requests depend on each other.
 * `flows.md`, the source references in the OpenAPI specs and `API_MAP.md` are generated from it.
 * Decided in docs/decisions/0003-flows-format.md.
 *
 * Never holds real secret values: cookie and token values are replaced by descriptions of their
 * shape and origin (docs/decisions/0004-redaction.md).
 */
import { z } from 'zod'

export const FLOWS_FORMAT_VERSION = 1

export const SourceRefSchema = z.object({
  /** Original source path when a sourcemap was available, otherwise the bundle URL path. */
  file: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  functionName: z.string().nullable(),
  /** True when `file` is an original source file, false when it points into a bundle. */
  original: z.boolean(),
  /** Path of the saved excerpt inside the handoff folder (`source/...`), if one was written. */
  excerpt: z.string().nullable(),
})
export type SourceRef = z.infer<typeof SourceRefSchema>

/** A request location as text, e.g. `query.symbol`, `header.x-csrf-token`, `body./user/id`. */
const InputPathSchema = z.string()

/** Where an input value came from. */
export const ValueOriginSchema = z.discriminatedUnion('kind', [
  /** Produced by an earlier step's response. */
  z.object({
    kind: z.literal('step'),
    step: z.string(),
    /** Response location, e.g. `body./0/symbol`, `set-cookie.session`, `header.x-token`. */
    output: z.string(),
    /** How the value was encoded between response and request, if it changed. */
    transform: z.enum([
      'none',
      'url-encoded',
      'base64',
      'json-string',
      'substring',
    ]),
  }),
  /** Extracted from an HTML or text response. */
  z.object({
    kind: z.literal('html'),
    step: z.string(),
    selector: z.string(),
    attr: z.string().nullable(),
    pattern: z.string().nullable(),
    confidence: z.enum(['high', 'low']),
  }),
  /** Typed by the person into a form field. */
  z.object({
    kind: z.literal('user-input'),
    field: z.string(),
  }),
  /** Computed by the page's JavaScript; see `computedValues`. */
  z.object({
    kind: z.literal('computed'),
    computedId: z.string(),
  }),
  /** Identical in every captured session and found nowhere else: send it as-is. */
  z.object({
    kind: z.literal('constant'),
    value: z.string(),
  }),
  /** Set by the browser or a bot-protection script, not by any captured response. */
  z.object({
    kind: z.literal('browser'),
    note: z.string(),
  }),
  z.object({
    kind: z.literal('unknown'),
    /** Shape of the value, never the value itself: `<redacted: 32 hex chars>`. */
    shape: z.string(),
  }),
])
export type ValueOrigin = z.infer<typeof ValueOriginSchema>

export const FlowStepSchema = z.object({
  id: z.string(),
  operationId: z.string(),
  kind: z.enum(['api', 'page', 'bot-protection']),
  /** True when this step cannot be reproduced with plain HTTP (needs a real browser). */
  browserOnly: z.boolean(),
  /** One-line description built from the trigger label and the endpoint, without an LLM. */
  summary: z.string(),
  sentFrom: SourceRefSchema.nullable(),
  inputs: z.record(InputPathSchema, ValueOriginSchema),
  /** Response locations that later steps use, keyed by a short name. */
  outputs: z.record(z.string(), z.string()),
  /** Exchange ids this step was derived from, for debugging. */
  observedIn: z.array(z.string()),
})
export type FlowStep = z.infer<typeof FlowStepSchema>

export const FlowSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** What started the flow, taken from the person's own click, submit or navigation. */
  trigger: z.object({
    kind: z.enum(['click', 'submit', 'navigate', 'load']),
    label: z.string(),
    pageUrl: z.string(),
  }),
  steps: z.array(FlowStepSchema),
  /** How many sessions showed the same sequence. 2 or more means the edges are confirmed. */
  seenInSessions: z.number().int(),
})
export type Flow = z.infer<typeof FlowSchema>

export const ComputedValueSchema = z.object({
  id: z.string(),
  operationId: z.string(),
  /** Request location, e.g. `body./password`. */
  input: z.string(),
  producedBy: SourceRefSchema.nullable(),
  calledFrom: SourceRefSchema.nullable(),
  /** The browser API that produced it, e.g. `crypto.subtle.encrypt`, `btoa`, `JSEncrypt.encrypt`. */
  api: z.string().nullable(),
  details: z.record(z.string(), z.string()).nullable(),
  /** Other values the computation used, e.g. a public key from an earlier response. */
  uses: z.array(ValueOriginSchema),
  /** How it was found: matched a hooked crypto call, or traced through the source code. */
  evidence: z.enum(['transform-hook', 'source-trace', 'stack-only']),
})
export type ComputedValue = z.infer<typeof ComputedValueSchema>

export const SessionRequirementSchema = z.object({
  host: z.string(),
  /** Result of `probe` where available, otherwise inferred from captured traffic. */
  requires: z.enum([
    'none',
    'cookies',
    'token',
    'browser',
    'unknown',
  ]),
  /** Cookies the APIs need and which step sets each one. Names only, never values. */
  cookies: z.array(z.object({
    name: z.string(),
    setBy: z.string().nullable(),
    /**
     * Who sets it: `response` (a `Set-Cookie` header), `script` (a page script, with a value a
     * wrapper can derive and set itself, such as a store slug from a response), or `browser`
     * (a page script, often bot protection, with an opaque value only a real browser produces).
     */
    source: z.enum([
      'response',
      'browser',
      'script',
      'unknown',
    ]),
  })),
  botProtection: z.array(z.object({
    vendor: z.string(),
    evidence: z.string(),
  })),
  probed: z.boolean(),
})
export type SessionRequirement = z.infer<typeof SessionRequirementSchema>

/**
 * True when a cookie can only come from a real browser (`source: 'browser'`). Shared by `build`
 * and `probe`, so a derivable script-set cookie never turns a host into "needs a browser".
 */
export function cookieNeedsBrowser(cookie: Pick<SessionRequirement['cookies'][number], 'source'>): boolean {
  return cookie.source === 'browser'
}

export const FlowsDocumentSchema = z.object({
  $schema: z.string().optional(),
  formatVersion: z.literal(FLOWS_FORMAT_VERSION),
  generatedBy: z.string(),
  sessions: z.array(z.string()),
  session: z.array(SessionRequirementSchema),
  flows: z.array(FlowSchema),
  computedValues: z.array(ComputedValueSchema),
})
export type FlowsDocument = z.infer<typeof FlowsDocumentSchema>
