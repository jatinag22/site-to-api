/**
 * `probe.json`: results of replaying captured requests against the live site (decision 0012).
 * Holds header and cookie names only, never values, so it is safe to commit. `build` reads it to
 * fill session requirements and `x-site-to-api-requires`.
 */
import { z } from 'zod'

export const PROBE_FORMAT_VERSION = 1

export const ProbeOutcomeSchema = z.enum([
  /** Response matched the captured one (status class, media type, body shape). */
  'ok',
  /** Responded, but differently: an error status, a challenge page, a login redirect. */
  'rejected',
  /** Network error or timeout. */
  'failed',
  /** Not sent: the request can change data, or an earlier variant already failed. */
  'skipped',
])
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>

export const OperationProbeSchema = z.object({
  operationId: z.string(),
  host: z.string(),
  method: z.string(),
  /** Exchange whose request was replayed. */
  exchangeId: z.string(),
  /** Replayed exactly as captured (cookies and headers included). */
  replay: ProbeOutcomeSchema,
  /** Replayed with no cookies, no auth and only generic headers. */
  bare: ProbeOutcomeSchema,
  /**
   * Cookies and headers the request needs, found by removing one at a time while the replay
   * keeps working, e.g. `cookie:_abck`, `header:referer`. `null` when not tested.
   */
  requires: z.array(z.string()).nullable(),
  /**
   * The cookies and headers that were removed one at a time (`cookie:sid`), whether needed or
   * not. Only these can be called not needed (decision 0052); a bare request that worked tests
   * none of them one by one. Absent in older reports.
   */
  tested: z.array(z.string()).optional(),
  /** HTTP statuses seen, in the order the variants ran. */
  statuses: z.array(z.number().int()),
  note: z.string().nullable(),
  /**
   * Why a request was refused with and without the captured session: `bot-protection` answered
   * instead of the site, the `session` was refused (401/403), or `other` (another status, or a
   * response that looks different). Absent when the replay worked, and in older reports.
   */
  rejection: z.enum(['bot-protection', 'session', 'other']).optional(),
})
export type OperationProbe = z.infer<typeof OperationProbeSchema>

export const ProbeReportSchema = z.object({
  formatVersion: z.literal(PROBE_FORMAT_VERSION),
  generatedBy: z.string(),
  probedAt: z.string(),
  maxRps: z.number(),
  unsafeMethods: z.boolean(),
  /**
   * Operations per host that got the remove-one-at-a-time analysis (`probe.minimizePerHost`).
   * Absent in reports written before the limit was configurable, which used 5.
   */
  minimizePerHost: z.number().int().optional(),
  operations: z.array(OperationProbeSchema),
  skipped: z.array(z.object({
    operationId: z.string(),
    reason: z.string(),
  })),
})
export type ProbeReport = z.infer<typeof ProbeReportSchema>
