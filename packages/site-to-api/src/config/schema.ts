/**
 * Configuration schema. Precedence: CLI flags > environment variables > config file > defaults
 * (docs/decisions/0006-configuration.md). Every value is validated here, so a typo in a config
 * key or an environment variable fails loudly instead of being ignored.
 */
import { z } from 'zod'

const HostPattern = z.string().min(1)

export const ConfigSchema = z.strictObject({
  /** Raw captures: HAR files, sourcemaps, real cookies. Always gitignored. */
  rawDir: z.string().default('.site-to-api/raw'),
  /** Generated handoff folder: specs, flows, docs and client. Safe to commit. */
  outDir: z.string().default('api-handoff'),
  hosts: z.strictObject({
    /**
     * Hosts to analyse, as globs (`*.example.com`). Empty means every host that served a page
     * or an API call to a page, minus known analytics and ad networks.
     */
    include: z.array(HostPattern).default([]),
    exclude: z.array(HostPattern).default([]),
  }).prefault({}),
  capture: z.strictObject({
    browser: z.strictObject({
      /** Playwright channel, e.g. `chrome`. `null` uses Playwright's bundled Chromium. */
      channel: z.string().nullable().default('chrome'),
      headless: z.boolean().default(false),
      locale: z.string().nullable().default(null),
      timezone: z.string().nullable().default(null),
      userAgent: z.string().nullable().default(null),
      /** Reuse a browser profile directory so logins persist between captures. */
      userDataDir: z.string().nullable().default(null),
    }).prefault({}),
    /** Probe and unpack `.js.map` files for every script. */
    sourcemaps: z.boolean().default(true),
    /** Save every JavaScript bundle, so source analysis works without sourcemaps too. */
    saveScripts: z.boolean().default(true),
    /** Inject the request, crypto and action hooks into every page and worker. */
    instrument: z.boolean().default(true),
    websockets: z.boolean().default(true),
    /**
     * Module that drives the browser instead of a person: `export default async ({ page }) => {}`.
     * Used for repeatable captures and tests. `null` means interactive.
     */
    script: z.string().nullable().default(null),
  }).prefault({}),
  build: z.strictObject({
    /** Samples needed before an HTML or text response gets a high-confidence extraction spec. */
    minExtractSamples: z.number().int().min(1).default(2),
    /** Ignore values shorter than this when tracing values between requests. */
    minTraceValueLength: z.number().int().min(1).default(4),
    /** Write the source excerpts referenced by flows and specs into `source/`. */
    excerpts: z.boolean().default(true),
  }).prefault({}),
  redact: z.strictObject({
    /**
     * `masked` keeps formats but replaces personal and secret values, `raw` copies captured
     * values into committed files, `none` writes no examples at all.
     */
    examples: z.enum(['masked', 'raw', 'none']).default('masked'),
    maxExamples: z.number().int().min(0).max(25).default(3),
    /** Extra patterns to treat as personal data. */
    patterns: z.array(z.strictObject({
      name: z.string(),
      regex: z.string(),
    })).default([]),
    /** Field or header names to always redact, matched case-insensitively. */
    fields: z.array(z.string()).default([]),
  }).prefault({}),
  probe: z.strictObject({
    /** Requests per second against the live site. */
    maxRps: z.number().positive().max(10).default(1),
    /** Replay POST, PUT, PATCH and DELETE too. Off by default: they can change data. */
    unsafeMethods: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(15_000),
  }).prefault({}),
  gen: z.strictObject({
    /** Generate the TypeScript client into `<outDir>/client`. */
    client: z.boolean().default(true),
  }).prefault({}),
})

export type ResolvedConfig = z.infer<typeof ConfigSchema>
export type UserConfig = z.input<typeof ConfigSchema>

/** Identity helper that gives config files type checking and autocomplete. */
export function defineConfig(config: UserConfig): UserConfig {
  return config
}
