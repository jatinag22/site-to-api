/**
 * Configuration schema. Precedence: CLI flags > environment variables > config file > defaults
 * (docs/decisions/0006-configuration.md). Every value is validated here, so a typo in a config
 * key or an environment variable fails loudly instead of being ignored.
 */
import { z } from 'zod'

const HostPattern = z.string().min(1)

/**
 * Playwright channels of Chromium-based browsers, the only kind capture drives. `chromium` is
 * Playwright's Chromium in its new headless mode; `null` (`--channel bundled`) is its Chromium.
 */
export const BROWSER_CHANNELS = [
  'chrome',
  'chrome-beta',
  'chrome-dev',
  'chrome-canary',
  'msedge',
  'msedge-beta',
  'msedge-dev',
  'msedge-canary',
  'chromium',
] as const

export const ConfigSchema = z.strictObject({
  /** Raw captures: HAR files, sourcemaps, real cookies. Always gitignored. */
  rawDir: z.string().default('.site-to-api/raw'),
  /** Generated handoff folder: specs, flows, docs and client. Redacted by default; review before publishing. */
  outDir: z.string().default('api-handoff'),
  hosts: z.strictObject({
    /**
     * Hosts to analyse, as globs (`*.example.com`). Empty means every host that served a page
     * or an API call to a page, minus known analytics and ad networks.
     */
    include: z.array(HostPattern).default([]),
    /** Hosts never to analyse, as globs; applied after `include`. */
    exclude: z.array(HostPattern).default([]),
  }).prefault({}),
  capture: z.strictObject({
    browser: z.strictObject({
      /**
       * Playwright channel of a Chromium-based browser (`chrome`, `msedge`, ...). `null` uses
       * Playwright's bundled Chromium. Left at the default, a machine without Chrome falls back
       * to the bundled Chromium; set explicitly, the channel is required.
       */
      channel: z.enum(BROWSER_CHANNELS).nullable().default('chrome'),
      /** Run the browser without a window. Needs `capture.script`; sites with bot protection often block it. */
      headless: z.boolean().default(false),
      /**
       * Keep the headful browser but minimize its windows, so a scripted capture does not take
       * over the screen. Unlike `headless`, sites see an ordinary browser. Ignored when headless.
       */
      minimized: z.boolean().default(false),
      /** Browser locale such as `en-GB`; `null` keeps the machine's. */
      locale: z.string().nullable().default(null),
      /** Time zone such as `Europe/London`; `null` keeps the machine's. */
      timezone: z.string().nullable().default(null),
      /** User agent to send instead of the browser's own; `null` keeps it. */
      userAgent: z.string().nullable().default(null),
      /** Reuse a browser profile directory so logins persist between captures. */
      userDataDir: z.string().nullable().default(null),
      /**
       * Run Chromium with its sandbox (decision 0047). Captured sites are untrusted; Playwright
       * turns the sandbox off unless asked. Where the sandbox cannot start (many Linux containers
       * and CI runners) the capture retries once without it and warns. Set false to skip that.
       */
      sandbox: z.boolean().default(true),
      /**
       * Start the browser with `--mute-audio` (decision 0050): a capture opens pages that autoplay
       * video and sound, and the person running it should not hear them. Set false to hear them.
       */
      muteAudio: z.boolean().default(true),
    }).prefault({}),
    /** Probe and unpack `.js.map` files for every script. */
    sourcemaps: z.boolean().default(true),
    /** Save every JavaScript bundle, so source analysis works without sourcemaps too. */
    saveScripts: z.boolean().default(true),
    /** Inject the request, response, crypto and action hooks into every page (not workers). */
    instrument: z.boolean().default(true),
    /** Record WebSocket frames and server-sent events into `events.jsonl`. */
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
    /** Example values kept per field in the handoff folder (0 to 25). */
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
    /** Replay POST, PUT, PATCH and DELETE, GraphQL mutations and GraphQL operations of unknown type too. Off by default: they can change data. */
    unsafeMethods: z.boolean().default(false),
    /** How long one replayed request may take, in milliseconds. */
    timeoutMs: z.number().int().positive().default(15_000),
    /**
     * Operations per host that get the remove-one-at-a-time analysis that finds which cookies and
     * headers a request needs. It costs one request per cookie and header, so it is capped.
     */
    minimizePerHost: z.number().int().min(0).default(5),
  }).prefault({}),
  gen: z.strictObject({
    /** Generate the TypeScript client (into `clientDir`). */
    client: z.boolean().default(true),
    /**
     * Where the client goes, relative to the working directory like `outDir`; `null` means
     * `<outDir>/client`. Lets the client live in the app's source tree apart from the handoff
     * folder (decision 0058).
     */
    clientDir: z.string().min(1).nullable().default(null),
    /**
     * Also write an MCP server with one tool per operation (into `mcpDir`): `read` exposes the
     * operations that only read data, `write` all of them, `off` writes none (decision 0043).
     */
    mcp: z.enum(['off', 'read', 'write']).default('off'),
    /**
     * Where the MCP server goes, relative to the working directory; `null` means `mcp/` next to
     * the client folder. Never inside the client folder: it is a separate program with its own
     * dependencies, and the app's code never imports it (decision 0058).
     */
    mcpDir: z.string().min(1).nullable().default(null),
  }).prefault({}),
})

export type ResolvedConfig = z.infer<typeof ConfigSchema>
export type UserConfig = z.input<typeof ConfigSchema>

/** Identity helper that gives config files type checking and autocomplete. */
export function defineConfig(config: UserConfig): UserConfig {
  return config
}
