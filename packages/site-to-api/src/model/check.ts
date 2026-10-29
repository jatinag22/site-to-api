/**
 * `check.json`: what `site-to-api check` found when it replayed safe requests against the live
 * site and compared each answer with the operation's response schema (decision 0044). Holds
 * field paths only, never values, so it is safe to commit.
 */
import { z } from 'zod'

export const CHECK_FORMAT_VERSION = 1

const TypeChangeSchema = z.object({
  /** Field path, e.g. `$.items[].price`; `$` is the whole body. */
  path: z.string(),
  /** What the schema allows: a JSON type (`string`, `integer | null`) or `enum`. */
  expected: z.string(),
  /** What the live body had: a JSON type, or `value outside the enum`. */
  actual: z.string(),
})
export type TypeChange = z.infer<typeof TypeChangeSchema>

const OperationCheckSchema = z.object({
  operationId: z.string(),
  host: z.string(),
  method: z.string(),
  /** The spec path, e.g. `/api/products/{productId}`. */
  path: z.string(),
  /**
   * `ok`: same status, nothing added, removed or retyped. `drift`: something changed.
   * `blocked`: bot protection or a refused session answered instead of the site (see
   * `rejection`). `unreachable`: no answer. The last two say nothing about drift.
   */
  verdict: z.enum([
    'ok',
    'drift',
    'blocked',
    'unreachable',
  ]),
  /** Status of the captured response, and of the live one (`null` when there was no answer). */
  status: z.object({
    expected: z.number().int(),
    actual: z.number().int().nullable(),
  }),
  /** Fields the live body has that the schema does not list. */
  added: z.array(z.string()),
  /** Required fields the live body lacks. */
  removed: z.array(z.string()),
  typeChanged: z.array(TypeChangeSchema),
  /** Probe's classification of a `blocked` answer (decision 0036). */
  rejection: z.enum(['bot-protection', 'session']).optional(),
  note: z.string().nullable(),
})
export type OperationCheck = z.infer<typeof OperationCheckSchema>

export const CheckReportSchema = z.object({
  formatVersion: z.literal(CHECK_FORMAT_VERSION),
  generatedBy: z.string(),
  checkedAt: z.string(),
  maxRps: z.number(),
  /** `0` no drift and everything checked, `1` drift, `2` an operation could not be checked. */
  exitCode: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
  ]),
  operations: z.array(OperationCheckSchema),
  skipped: z.array(z.object({
    operationId: z.string(),
    reason: z.string(),
  })),
})
export type CheckReport = z.infer<typeof CheckReportSchema>
