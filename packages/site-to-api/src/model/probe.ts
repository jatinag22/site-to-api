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
  /** HTTP statuses seen, in the order the variants ran. */
  statuses: z.array(z.number().int()),
  note: z.string().nullable(),
})
export type OperationProbe = z.infer<typeof OperationProbeSchema>

export const ProbeReportSchema = z.object({
  formatVersion: z.literal(PROBE_FORMAT_VERSION),
  generatedBy: z.string(),
  probedAt: z.string(),
  maxRps: z.number(),
  unsafeMethods: z.boolean(),
  operations: z.array(OperationProbeSchema),
  skipped: z.array(z.object({
    operationId: z.string(),
    reason: z.string(),
  })),
})
export type ProbeReport = z.infer<typeof ProbeReportSchema>
