/**
 * The boundary of `site-to-api import` (decision 0057): what a HAR exported from browser
 * DevTools (Chrome, Edge, Firefox, Safari) or a proxy (Charles, mitmproxy) may hold. The file is
 * untrusted input: only the shape is checked here, every entry again with load's schema, and
 * vendor fields are read only when they have the expected shape.
 */
import { z } from 'zod'

/** The top level of a HAR file; entries are checked one by one so one odd entry is a warning. */
export const ImportHarSchema = z.object({
  log: z.object({
    version: z.string().nullish(),
    creator: z.object({
      name: z.string().nullish(),
      version: z.string().nullish(),
    }).nullish(),
    browser: z.object({
      name: z.string().nullish(),
      version: z.string().nullish(),
    }).nullish(),
    pages: z.array(z.unknown()).nullish(),
    entries: z.array(z.unknown()),
  }),
})
export type ImportHar = z.infer<typeof ImportHarSchema>

/** A page of `log.pages`: Chrome gives its title, Firefox often the URL as title. */
export const HarPageSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  startedDateTime: z.string(),
})

/** A frame of Chrome's `_initiator.stack` (0-based line and column, as the DevTools protocol has them). */
const CallFrameSchema = z.object({
  url: z.string(),
  lineNumber: z.number().int(),
  columnNumber: z.number().int(),
  functionName: z.string().nullish(),
})

/** One level of Chrome's `_initiator.stack`; `parent` (the async caller) is read level by level. */
export const InitiatorStackSchema = z.object({
  callFrames: z.array(CallFrameSchema),
  parent: z.unknown().optional(),
})

/** Chrome's `_initiator` of an entry. */
export const InitiatorSchema = z.object({
  type: z.string(),
  stack: z.unknown().optional(),
})

/** One message of Chrome's `_webSocketMessages`: `time` in seconds, `opcode` 1 text, 2 binary. */
export const WebSocketMessageSchema = z.object({
  type: z.enum(['send', 'receive']),
  time: z.number(),
  opcode: z.number().int(),
  data: z.string(),
})
