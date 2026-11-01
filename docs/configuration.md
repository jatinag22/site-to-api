# Configuration reference

<!-- Generated from packages/site-to-api/src/config/schema.ts; do not edit by hand. Regenerate with:
     UPDATE_CONFIG_DOC=1 pnpm exec vitest --run packages/site-to-api/src/config/reference.test.ts -->

Every key `site-to-api` reads, with its default and meaning. Values come from, in increasing
precedence: the defaults below, a config file (`site-to-api.config.{ts,mts,js,mjs,json}`, or
`--config`), `SITE_TO_API_*` environment variables, and CLI flags (decision 0006). Unknown keys
are an error. `site-to-api config` prints the values in effect and where each came from.

Environment variables use `__` between levels and `_` between words, and are parsed as JSON
when they can be: `SITE_TO_API_PROBE__MAX_RPS=0.5`, `SITE_TO_API_HOSTS__INCLUDE='["*.example.com"]'`.

## Top level

| Key | Type | Default | Environment variable | Meaning |
| --- | --- | --- | --- | --- |
| `rawDir` | string | `".site-to-api/raw"` | `SITE_TO_API_RAW_DIR` | Raw captures: HAR files, sourcemaps, real cookies. Always gitignored. |
| `outDir` | string | `"api-handoff"` | `SITE_TO_API_OUT_DIR` | Generated handoff folder: specs, flows, docs and client. Redacted by default; review before publishing. |

## `hosts`

| Key | Type | Default | Environment variable | Meaning |
| --- | --- | --- | --- | --- |
| `hosts.include` | array of string | `[]` | `SITE_TO_API_HOSTS__INCLUDE` | Hosts to analyse, as globs (`*.example.com`). Empty means every host that served a page or an API call to a page, minus known analytics and ad networks. |
| `hosts.exclude` | array of string | `[]` | `SITE_TO_API_HOSTS__EXCLUDE` | Hosts never to analyse, as globs; applied after `include`. |

## `capture.browser`

| Key | Type | Default | Environment variable | Meaning |
| --- | --- | --- | --- | --- |
| `capture.browser.channel` | `"chrome"`, `"chrome-beta"`, `"chrome-dev"`, `"chrome-canary"`, `"msedge"`, `"msedge-beta"`, `"msedge-dev"`, `"msedge-canary"`, `"chromium"` or null | `"chrome"` | `SITE_TO_API_CAPTURE__BROWSER__CHANNEL` | Playwright channel of a Chromium-based browser (`chrome`, `msedge`, ...). `null` uses Playwright's bundled Chromium. Left at the default, a machine without Chrome falls back to the bundled Chromium; set explicitly, the channel is required. |
| `capture.browser.headless` | boolean | `false` | `SITE_TO_API_CAPTURE__BROWSER__HEADLESS` | Run the browser without a window. Needs `capture.script`; sites with bot protection often block it. |
| `capture.browser.minimized` | boolean | `false` | `SITE_TO_API_CAPTURE__BROWSER__MINIMIZED` | Keep the headful browser but minimize its windows, so a scripted capture does not take over the screen. Unlike `headless`, sites see an ordinary browser. Ignored when headless. |
| `capture.browser.locale` | string or null | `null` | `SITE_TO_API_CAPTURE__BROWSER__LOCALE` | Browser locale such as `en-GB`; `null` keeps the machine's. |
| `capture.browser.timezone` | string or null | `null` | `SITE_TO_API_CAPTURE__BROWSER__TIMEZONE` | Time zone such as `Europe/London`; `null` keeps the machine's. |
| `capture.browser.userAgent` | string or null | `null` | `SITE_TO_API_CAPTURE__BROWSER__USER_AGENT` | User agent to send instead of the browser's own; `null` keeps it. |
| `capture.browser.userDataDir` | string or null | `null` | `SITE_TO_API_CAPTURE__BROWSER__USER_DATA_DIR` | Reuse a browser profile directory so logins persist between captures. |
| `capture.browser.sandbox` | boolean | `true` | `SITE_TO_API_CAPTURE__BROWSER__SANDBOX` | Run Chromium with its sandbox (decision 0047). Captured sites are untrusted; Playwright turns the sandbox off unless asked. Where the sandbox cannot start (many Linux containers and CI runners) the capture retries once without it and warns. Set false to skip that. |
| `capture.browser.muteAudio` | boolean | `true` | `SITE_TO_API_CAPTURE__BROWSER__MUTE_AUDIO` | Start the browser with `--mute-audio` (decision 0050): a capture opens pages that autoplay video and sound, and the person running it should not hear them. Set false to hear them. |

## `capture`

| Key | Type | Default | Environment variable | Meaning |
| --- | --- | --- | --- | --- |
| `capture.sourcemaps` | boolean | `true` | `SITE_TO_API_CAPTURE__SOURCEMAPS` | Probe and unpack `.js.map` files for every script. |
| `capture.saveScripts` | boolean | `true` | `SITE_TO_API_CAPTURE__SAVE_SCRIPTS` | Save every JavaScript bundle, so source analysis works without sourcemaps too. |
| `capture.instrument` | boolean | `true` | `SITE_TO_API_CAPTURE__INSTRUMENT` | Inject the request, response, crypto and action hooks into every page (not workers). |
| `capture.websockets` | boolean | `true` | `SITE_TO_API_CAPTURE__WEBSOCKETS` | Record WebSocket frames and server-sent events into `events.jsonl`. |
| `capture.script` | string or null | `null` | `SITE_TO_API_CAPTURE__SCRIPT` | Module that drives the browser instead of a person: `export default async ({ page }) => {}`. Used for repeatable captures and tests. `null` means interactive. |

## `build`

| Key | Type | Default | Environment variable | Meaning |
| --- | --- | --- | --- | --- |
| `build.minExtractSamples` | whole number | `2` | `SITE_TO_API_BUILD__MIN_EXTRACT_SAMPLES` | Samples needed before an HTML or text response gets a high-confidence extraction spec. |
| `build.minTraceValueLength` | whole number | `4` | `SITE_TO_API_BUILD__MIN_TRACE_VALUE_LENGTH` | Ignore values shorter than this when tracing values between requests. |
| `build.excerpts` | boolean | `true` | `SITE_TO_API_BUILD__EXCERPTS` | Write the source excerpts referenced by flows and specs into `source/`. |

## `redact`

| Key | Type | Default | Environment variable | Meaning |
| --- | --- | --- | --- | --- |
| `redact.examples` | `"masked"`, `"raw"`, `"none"` | `"masked"` | `SITE_TO_API_REDACT__EXAMPLES` | `masked` keeps formats but replaces personal and secret values, `raw` copies captured values into committed files, `none` writes no examples at all. |
| `redact.maxExamples` | whole number | `3` | `SITE_TO_API_REDACT__MAX_EXAMPLES` | Example values kept per field in the handoff folder (0 to 25). |
| `redact.patterns` | array of object (`name`, `regex`) | `[]` | `SITE_TO_API_REDACT__PATTERNS` | Extra patterns to treat as personal data. |
| `redact.fields` | array of string | `[]` | `SITE_TO_API_REDACT__FIELDS` | Field or header names to always redact, matched case-insensitively. |

## `probe`

| Key | Type | Default | Environment variable | Meaning |
| --- | --- | --- | --- | --- |
| `probe.maxRps` | number | `1` | `SITE_TO_API_PROBE__MAX_RPS` | Requests per second against the live site. |
| `probe.unsafeMethods` | boolean | `false` | `SITE_TO_API_PROBE__UNSAFE_METHODS` | Replay POST, PUT, PATCH and DELETE, GraphQL mutations and GraphQL operations of unknown type too. Off by default: they can change data. |
| `probe.timeoutMs` | whole number | `15000` | `SITE_TO_API_PROBE__TIMEOUT_MS` | How long one replayed request may take, in milliseconds. |
| `probe.minimizePerHost` | whole number | `5` | `SITE_TO_API_PROBE__MINIMIZE_PER_HOST` | Operations per host that get the remove-one-at-a-time analysis that finds which cookies and headers a request needs. It costs one request per cookie and header, so it is capped. |

## `gen`

| Key | Type | Default | Environment variable | Meaning |
| --- | --- | --- | --- | --- |
| `gen.client` | boolean | `true` | `SITE_TO_API_GEN__CLIENT` | Generate the TypeScript client into `<outDir>/client`. |
| `gen.mcp` | `"off"`, `"read"`, `"write"` | `"off"` | `SITE_TO_API_GEN__MCP` | Also write `client/mcp/`, an MCP server with one tool per operation: `read` exposes the operations that only read data, `write` all of them, `off` writes none (decision 0043). |
