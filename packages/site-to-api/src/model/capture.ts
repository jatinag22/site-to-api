/**
 * On-disk format of one raw capture session, written by `capture` and read by `build`.
 *
 * Layout of `<rawDir>/<sessionId>/`:
 * - `meta.json`        {@link SessionMeta}
 * - `traffic.har`      HAR 1.2 recorded by Playwright with bodies embedded
 * - `events.jsonl`     one {@link CaptureEvent} per line, from the injected instrumentation
 * - `scripts/<host>/<path>`   every JavaScript file the pages loaded (saved even without a sourcemap)
 * - `sourcemaps/<host>/<path>.map`  sourcemaps that were found
 * - `sources/<host>/<original path>` original files unpacked from those sourcemaps
 *
 * Everything under the raw directory holds real cookies, tokens and personal data, so the
 * capture step always writes a `.gitignore` containing `*` at the raw directory root.
 */
import { z } from 'zod'

export const RAW_FORMAT_VERSION = 1

export const SessionMetaSchema = z.object({
  formatVersion: z.literal(RAW_FORMAT_VERSION),
  sessionId: z.string(),
  toolVersion: z.string(),
  startUrl: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  browser: z.object({
    channel: z.string().nullable(),
    headless: z.boolean(),
    userAgent: z.string(),
  }),
  /** Path of the HAR file relative to the session directory. */
  har: z.string(),
  events: z.string(),
  scripts: z.array(z.object({
    url: z.string(),
    /** Saved bundle, relative to the session directory. */
    file: z.string(),
    sourceMap: z.object({
      url: z.string(),
      file: z.string(),
      /** Files unpacked from the map, relative to the session directory. */
      sources: z.array(z.string()),
    }).nullable(),
  })),
})
export type SessionMeta = z.infer<typeof SessionMetaSchema>

/** One frame of a JavaScript stack, as reported by the browser (bundle coordinates, 1-based). */
export const StackFrameSchema = z.object({
  url: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  functionName: z.string().nullable(),
})
export type StackFrame = z.infer<typeof StackFrameSchema>

const base = {
  /** Milliseconds since epoch, from the page clock. */
  ts: z.number(),
  pageUrl: z.string(),
}

/** A request the page's own code started, with the JavaScript stack at the moment it was sent. */
export const RequestEventSchema = z.object({
  ...base,
  t: z.literal('request'),
  via: z.enum(['fetch', 'xhr', 'beacon', 'form']),
  method: z.string(),
  url: z.string(),
  /** First 2 KB of the request body, to tell apart concurrent requests to the same URL. */
  bodyPreview: z.string().nullable(),
  stack: z.array(StackFrameSchema),
})

/**
 * A call to an encoding or crypto API (`btoa`, `crypto.subtle.*`, `TextEncoder`, known libraries
 * such as CryptoJS or JSEncrypt). The output is matched against later request values to find
 * which function computed them.
 */
export const TransformEventSchema = z.object({
  ...base,
  t: z.literal('transform'),
  api: z.string(),
  /** Output as text; binary outputs are base64 and hex encoded so either form can match. */
  output: z.array(z.string()),
  /** Short previews of the inputs (truncated to 256 chars each). */
  inputs: z.array(z.string()),
  /** Algorithm details when the API exposes them, e.g. `{ name: 'RSA-OAEP' }`. */
  details: z.record(z.string(), z.string()).nullable(),
  stack: z.array(StackFrameSchema),
})

/** Something the person did in the page. Used to split traffic into flows and name them. */
export const ActionEventSchema = z.object({
  ...base,
  t: z.literal('action'),
  kind: z.enum([
    'click',
    'submit',
    'navigate',
    'change',
  ]),
  /** Human label: button text, aria-label, link text, field label or the new page title. */
  label: z.string(),
  /** A CSS selector for the target element (empty for navigations). */
  selector: z.string(),
  /** For `change`: the field name. Values are never recorded here. */
  field: z.string().nullable(),
})

export const WebSocketEventSchema = z.object({
  ...base,
  t: z.literal('ws'),
  url: z.string(),
  direction: z.enum(['open', 'sent', 'received', 'close']),
  /** Text frames as-is, binary frames base64 encoded. */
  data: z.string().nullable(),
})

export const CaptureEventSchema = z.discriminatedUnion('t', [
  RequestEventSchema,
  TransformEventSchema,
  ActionEventSchema,
  WebSocketEventSchema,
])
export type CaptureEvent = z.infer<typeof CaptureEventSchema>
export type RequestEvent = z.infer<typeof RequestEventSchema>
export type TransformEvent = z.infer<typeof TransformEventSchema>
export type ActionEvent = z.infer<typeof ActionEventSchema>
export type WebSocketEvent = z.infer<typeof WebSocketEventSchema>
