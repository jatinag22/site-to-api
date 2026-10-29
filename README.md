# site-to-api

[![CI](https://github.com/jatinag22/site-to-api/actions/workflows/ci.yml/badge.svg)](https://github.com/jatinag22/site-to-api/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
![Node 22.12+](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg)

**Browse a website once. Get everything a coding agent needs to build a wrapper for its internal
API.**

![A scripted login capture on the fixture shop, then build, then the session needs and the computed password from AGENT.md](docs/assets/demo.gif)

`site-to-api` records what a site's own pages do while you use it, then works out, without any
LLM, the endpoints, their parameters and schemas, the order requests happen in, which value feeds
which request, the browser code that computes values like encrypted passwords, and what a session
needs. It writes all of that into one folder: OpenAPI 3.1 specs, a flows document, readable maps
for an agent, excerpts of the site's own source code, and a typed TypeScript client with Zod
validation.

> Status: pre-release (version `0.0.0` until the first release), not yet published to npm. See [Install](#install).

```
capture ──► build ──► probe (optional) ──► your coding agent builds the wrapper
 (browser)  (offline, deterministic)       reading api-handoff/AGENT.md
```

## Why

Building an integration for a site without a public API usually means hours in DevTools: finding
the endpoints, working out where the CSRF token comes from, discovering that the password is
RSA-encrypted in the browser, noticing a bot-protection cookie. `site-to-api` does that legwork
and hands the result to you or your coding agent in a form that is easy to act on:

- **Deterministic.** No LLM inside the tool. The same capture gives byte-identical output, so
  diffs are reviewable and nothing is guessed.
- **Flows, not just endpoints.** Every input of every request is traced to its origin: an earlier
  response (JSON field, header, cookie, or a selector in an HTML page), the browser's crypto, what
  you typed, a constant, or a cookie set by a page script.
- **Points at the code.** Sourcemaps are recovered and stack traces captured, so you get
  "`body.password` is computed by `encryptPassword()` in `src/auth/crypto.ts:26` using
  `crypto.subtle.encrypt` (RSA-OAEP), with the key from `GET /api/auth/key`", plus the excerpt.
- **Secrets stay local.** Raw captures live in a gitignored folder. The handoff folder is redacted
  by default: cookie values, tokens and personal data are replaced by a description of their
  shape and origin.
- **Honest about sessions.** Bot protection (Akamai, AWS WAF, Cloudflare, PerimeterX, DataDome,
  Imperva, Kasada, captchas) is detected and recorded as "needs a real browser", never bypassed. `probe`
  measures what actually works with plain HTTP.

## Install

Requires Node 22.12+.

```sh
# from source until the first npm release
git clone https://github.com/jatinag22/site-to-api
cd site-to-api && pnpm install && pnpm run build
pnpm --filter site-to-api exec playwright install chromium   # only if you don't use your installed Chrome
# put the CLI on your PATH (works in scripts too, unlike a shell alias)
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/site-to-api/bin/site-to-api.mjs" ~/.local/bin/site-to-api
site-to-api --version
```

If `site-to-api` is not found, add `~/.local/bin` to your `PATH`.

## Quick start

```sh
mkdir my-wrapper && cd my-wrapper
site-to-api init                       # config file + gitignore for raw captures
site-to-api capture https://example.com
#   a Chrome window opens: use the site the way your wrapper will (log in, search, open pages),
#   then close the window
site-to-api capture https://example.com --session second-pass
#   optional but recommended: a second pass over the same pages gives the tool two samples
site-to-api build                      # writes api-handoff/
site-to-api probe                      # optional: checks what works with plain HTTP (1 req/s, GET only)
```

Then point your coding agent at `api-handoff/AGENT.md`.

### Try it on the fixture shop first

The repository includes Pinewood Market, a fictional shop the end-to-end tests run against. It
has a login with a browser-encrypted password, a CSRF token, toy bot protection, HTML tables and a
CSV export. From the repository root, in two terminals:

```sh
# terminal 1: the shop on http://localhost:4173
pnpm --filter @site-to-api/e2e run fixture
```

```sh
# terminal 2: three scripted browsing sessions, then build
REPO=/path/to/site-to-api        # your clone
mkdir -p /tmp/pinewood && cd /tmp/pinewood
site-to-api init
for s in browse browse-again login; do
  site-to-api capture http://localhost:4173 --headless --channel bundled --session $s \
    --script "$REPO/e2e/scenarios/$s.ts"
done
site-to-api build      # 27 operations, 20 flows → ./api-handoff
site-to-api probe      # optional: checks the session needs against the live shop
```

`--script` drives the browser from a file so the run is repeatable; drop it (and `--headless`) to
browse by hand. Sites with bot protection usually block headless browsers: for those, use
`--channel chrome --minimized` instead, a normal browser whose windows stay minimized. The shop's test account is `demo` / `demo-password` (fictional, local only).

## What you get

```
api-handoff/
  AGENT.md            start here: a short index of the hosts, key flows, computed values, top gaps
  hosts/<host>.md     everything about one host: session needs, cookies, operations, channels, gaps
  GAPS.md             gaps of the whole build: probe state, build warnings (in full)
  API_MAP.md          one row per operation: inputs and their origins, response, client symbols
  flows.json          source of truth for flows (schema: flows.schema.json)
  flows.md            the same, readable
  specs/<host>.yaml   OpenAPI 3.1 with x-site-to-api-* extensions
  source/             excerpts of the site's own code referenced above (Markdown)
  client/             typed client: hey-api SDK + Zod schemas, wired to @site-to-api/runtime
  probe.json          after `probe`: what each request needs (names only)
  build.json          the options of the last build, which `probe` reuses
```

`AGENT.md` stays short on any site (under about 25 KB): one line per host, the login flow first,
grouped gaps, and links to the details. An excerpt generated from the fixture shop walkthrough
above:

```markdown
## Hosts

### The site's own hosts

- `localhost:4173`: a real browser sets up the session (confirmed by probe); bot protection:
  Akamai (cookie \_abck; cookie bm\_sz; request body matches sensor\_data); 18 API operations
  (1 seen in code only), 8 pages, 1 bot-protection step, 3 channels, 19 gaps.
  [`hosts/localhost_4173.md`](hosts/localhost_4173.md)

## Key flows

- [Sign in](flows.md#sign-in-2) (submit): `getApiAuthKey` → `postApiAuthLogin` → `getAccount` →
  `postShieldCollect` → `getApiMe`

## Values computed in the browser

- `body./password` of `postApiAuthLogin`: `src/auth/crypto.ts:26 encryptPassword` using
  `crypto.subtle.encrypt` (name=RSA-OAEP); it uses `body./publicKey` from `getApiAuthKey`, the
  `password` field.
```

And from `hosts/localhost_4173.md`, the session needs of that host:

```markdown
- Needs: a real browser is needed to establish the session; reuse its cookies for plain HTTP
  calls (confirmed by probe).
- Bot protection: Akamai (cookie \_abck; cookie bm\_sz; request body matches sensor\_data). Do
  not try to reproduce it; let a real browser run it (`browserSession` in `@site-to-api/runtime`).
- Cookie `_abck`: set by `postShieldCollect`. Needed by 5 requests (confirmed by probe).
- Cookie `bm_sz`: set by `getRoot`. Seen in capture, but none of the 13 requests probe tested
  needed it.
- Cookie `pm_session`: set by `postApiAuthLogin`. Seen in capture, but none of the 13 requests
  probe tested needed it.
- Cookie `pm_store`: set by a script in the page; the wrapper can set its value itself. Seen in
  capture, but none of the 13 requests probe tested needed it.
```

The full format is specified in [docs/output-format.md](docs/output-format.md).

## Commands

| Command | What it does |
|---|---|
| `init` | Writes `site-to-api.config.ts` and gitignores `.site-to-api/` |
| `capture [url]` | Opens a browser and records everything until you close it. `--script <file>` drives it from code instead (a failing script or Ctrl+C still saves the session, marked incomplete, and exits 1); `--headless`; `--channel chrome\|msedge\|bundled`; `--user-data-dir` keeps logins |
| `build` | Analyses every capture and writes the handoff folder, including the client. `--include/--exclude <host>`, `--examples masked\|raw\|none`, `--no-client`, `--mcp [read\|write]` |
| `probe` | Replays captured requests against the live site, rate limited, safe methods (and GraphQL queries) only unless `--unsafe-methods`; works out the needed cookies and headers for up to `--minimize-per-host <n>` operations per host (default 5); rebuilds the handoff folder with the flags of the last `build` (from `build.json`) and prints a summary |
| `gen` | Regenerates only `client/` from an existing handoff folder (no raw captures needed) and updates the client lines of `AGENT.md` and `API_MAP.md`. `--mcp [read\|write]` also writes `client/mcp/`, an MCP server for the site |
| `mcp [dir]` | Serves the handoff folder to an AI agent as an MCP server over stdio (read-only tools; see [Use with AI agents](#use-with-ai-agents-mcp)). `--allow-calls` adds `call_operation`, `--unsafe-methods`, `--max-rps <n>` |
| `config` | Prints the resolved config and where each value came from; `--json` for machine-readable output |

Options every command accepts: `-c, --config <file>`, `--cwd <dir>`, `--raw-dir <dir>`,
`--out-dir <dir>`. `probe` also takes `--max-rps <n>`, `--unsafe-methods`,
`--minimize-per-host <n>` and the output flags of `build` (`--include`, `--exclude`,
`--examples`, `--no-client`) to override the ones it reuses. `site-to-api <command> --help`
lists them.

## Configuration

```ts
// site-to-api.config.ts
import { defineConfig } from 'site-to-api'

export default defineConfig({
  rawDir: '.site-to-api/raw', // real cookies and tokens live here; gitignored
  outDir: 'api-handoff',
  hosts: {
    include: ['*.example.com'],
    exclude: []
  },
  capture: {
    browser: { channel: 'chrome', headless: false }
  },
  redact: { examples: 'masked' }, // 'raw' copies real values into the handoff folder
  probe: { maxRps: 1, unsafeMethods: false, minimizePerHost: 5 },
})
```

Precedence: CLI flags > `SITE_TO_API_*` environment variables > config file > defaults. Unknown
keys are errors, and `site-to-api config` shows which source set each value.

Environment variables name a config key in upper snake case, with `__` between nesting levels:
`rawDir` → `SITE_TO_API_RAW_DIR`, `redact.examples` → `SITE_TO_API_REDACT__EXAMPLES`,
`probe.maxRps` → `SITE_TO_API_PROBE__MAX_RPS`. Values are read as JSON when they parse
(`true`, `0.5`, `["*.example.com"]`), otherwise as text.

The flags and variables a `build` ran with (`--examples`, `--include`, `--exclude`,
`--no-client`, `--mcp`) are recorded in `build.json` and reused by `probe`, so probing does not undo them; flags and variables given to `probe` win.

## Using the generated client

### Project setup

The generated client is TypeScript that imports `@site-to-api/runtime` and `zod` 4. Your project
is the folder that holds `api-handoff/` (the one you ran `init` in). Until the first npm release,
install the runtime from your clone:

```sh
npm init -y && npm pkg set type=module          # ES modules
npm install /path/to/site-to-api/packages/runtime zod@4
npm install playwright tsx typescript            # playwright only for browser sessions
npm install -D @types/node /path/to/site-to-api/packages/site-to-api   # Node types; config types
```

A `tsconfig.json` that type-checks the whole folder, `api-handoff/` included:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noEmit": true
  }
}
```

`"module": "esnext"` with `"moduleResolution": "bundler"` works too. Run files with `tsx`, or drop
`noEmit`, compile with `tsc` and run with `node`. Code excerpts in `source/` are Markdown files
(`crypto.L18-28.ts.md`) with the code in a fence: they are fragments of the site's code, for
reading, so the compiler never sees them.

### Example: log in and list orders on the fixture shop

This is the complete wrapper an agent would write from the handoff folder of the walkthrough
above. The shop needs a browser session (bot protection), a CSRF token from the login page, a
password encrypted in the browser, and a bearer token. It was run as written in a fresh project
and prints `200 3 orders`:

```ts
import { chromium } from 'playwright'
import { browserSession, CookieJar, createSiteClient, extractCsrfTokenFromGetLogin } from './api-handoff/client/index.js'

// Ported from the site's own code: api-handoff/source/src/auth/crypto.L18-28.ts.md
async function encryptPassword(password: string, publicKeySpki: string): Promise<string> {
  const spki = Uint8Array.from(atob(publicKeySpki), char => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(password))
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
}

const jar = new CookieJar()
// The shop sits behind bot protection: a real browser loads it once, its cookies are reused.
const session = browserSession({
  jar,
  bootstrap: async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
      return await page.context().cookies()
    }
    finally {
      await browser.close()
    }
  },
})

let token: string | undefined
const { sdk } = createSiteClient({
  host: 'localhost:4173',
  session,
  jar,
  auth: () => token && `Bearer ${token}`, // sent to operations the spec marks as secured
})

const loginPage = await sdk.getLogin({})
const csrf = extractCsrfTokenFromGetLogin(String(loginPage.data))
const { data: key } = await sdk.getApiAuthKey({})
const login = await sdk.postApiAuthLogin({
  headers: { 'x-csrf-token': csrf ?? '' },
  body: { username: 'demo', password: await encryptPassword('demo-password', key!.publicKey) },
})
token = login.data?.token

const orders = await sdk.getApiOrders({})
console.log(orders.response?.status, orders.data?.orders.length, 'orders')
```

GraphQL operations get a function each, named after the operation, that sends the operation name,
the persisted-query hash or the document itself; you pass only the variables, typed from the
capture: `await sdk.queryArtistOverview({ variables: { uri } })`. GET operations encode
`variables` as JSON in the query string, as the site does.

Endpoints where one parameter picks the function (`?functionName=getSymbolData`,
`admin-ajax.php` with `action=`, JSON-RPC `method`) get one function per captured value, which
sends that parameter itself: `await sdk.getSymbolData({ query: { symbol } })`.

`createSiteClient` configures one shared client per host; calling it again for the same host
replaces the configuration. Hosts that work with plain HTTP need no browser: leave out `session`, or
use `tokenSession`. `api-handoff/client/README.md` says what each host needs, which operations are
secured and how to send `auth`.

## Use with AI agents (MCP)

Two MCP servers, both over stdio (decision 0043).

**Explore the handoff folder.** `site-to-api mcp` lets an agent look up one operation at a time
instead of reading every spec. It reads only the redacted handoff files, never the raw captures.

```sh
claude mcp add site-api -- site-to-api mcp ./api-handoff
```

Tools: `list_hosts` (hosts, session needs, flows), `search_operations` (by words, host, kind),
`get_operation` (spec slice, each input and where its value comes from, session needs, the client
call), `get_flow`, `get_examples` (masked examples only; refused for `--examples raw` folders) and
`get_source` (excerpts in `source/`). Other clients take the same command in their MCP settings
(`"command": "site-to-api", "args": ["mcp", "./api-handoff"]`).

`--allow-calls` adds `call_operation`, which sends a request through the generated client with
probe's rules: safe methods and GraphQL queries only, never bot-protection steps or state-changing
paths, rate limited (`--max-rps`, default 1 per second), no retries; `--unsafe-methods` allows
writes. Credentials come only from environment variables you set:

```sh
claude mcp add site-api -e SITE_API_COOKIE='session=…' -e SITE_API_AUTH='Bearer …' \
  -- site-to-api mcp ./api-handoff --allow-calls
```

With several hosts, use `SITE_API_COOKIE_<HOST>` / `SITE_API_AUTH_<HOST>` (the host's folder
under `client/` in upper case, e.g. `SITE_API_COOKIE_SHOP_EXAMPLE_COM`); the plain names are then
ignored, so a cookie is never sent to the wrong site.

**A server for one site.** `site-to-api gen --mcp` (or `build --mcp`, or `gen: { mcp: 'read' }` in
the config) writes `api-handoff/client/mcp/server.ts`: one tool per operation, input schemas from
the generated Zod schemas, calls through the typed client. `read` (the default) exposes only
operations that read; `--mcp write` adds the ones that change data. Bot-protection steps never get
a tool. Run it with the same packages as the client plus the SDK:

```sh
npm install @modelcontextprotocol/server@2.4.0 zod @site-to-api/runtime && npm install -D tsx
claude mcp add pinewood -e SITE_API_COOKIE='…' -- npx tsx ./api-handoff/client/mcp/server.ts
```

`api-handoff/client/mcp/README.md` lists its settings and a JSON configuration for other clients.

### Claude Code plugin and agent skill

The repository is also a Claude Code plugin marketplace. The plugin adds the `site-to-api` MCP
server above (on the project's `api-handoff/`), the commands `/site-to-api:capture` (Chrome,
window minimized), `/site-to-api:build`, `/site-to-api:probe` and `/site-to-api:check`, and a skill
that walks an agent through capture, reading the handoff folder, writing the wrapper and the
safety rules. Nothing is published yet, so install it from a clone (the `site-to-api` CLI must be
on your `PATH`, see [Install](#install)):

```sh
claude plugin marketplace add ./site-to-api      # the path of your clone
claude plugin install site-to-api@site-to-api
```

Inside Claude Code, `/plugin marketplace add ./site-to-api` and `/plugin install
site-to-api@site-to-api` do the same. For other agents (Cursor, Codex, anything that reads Agent
Skills), the same skill is a plain `skills/site-to-api/SKILL.md`; copy that folder into the
agent's skills directory, or `npx skills add <path-or-repo> -s site-to-api`.

## How it compares

Based on each project's README as of October 2026.

| | site-to-api | reverse-api-engineer | Spectral | Integuru | mitmproxy2swagger |
|---|---|---|---|---|---|
| Analysis | deterministic | LLM | LLM | LLM | deterministic |
| Request dependencies | yes | not documented | auth flow | yes | no |
| Sourcemaps and code references | yes | not documented | not documented | not documented | no |
| Output | specs, flows, docs, TS client | client code, many languages | MCP tools, OpenAPI | Python code | OpenAPI |
| Secrets redacted by default | yes | not documented | not documented | not documented | not documented |
| GraphQL, one operation per query or mutation | yes | not documented | not documented | not documented | no |
| Dispatcher endpoints (`action=`, JSON-RPC), one operation per function | yes | not documented | not documented | not documented | no |

## Responsible use

Use it to integrate with services you are allowed to use, respect terms of use and rate limits,
and prefer an official API when one exists. The tool never defeats bot protection, captchas or
access controls, and never hides that the browser is automated. See
[docs/responsible-use.md](docs/responsible-use.md).

## Limitations

- Web Workers and Service Workers are not instrumented (their traffic is captured, without stacks).
- Redaction is pattern-based. Review the handoff folder before publishing it.
- HTML/text extraction from a single sample is low confidence; capture a second pass.
- GraphQL operations are split by operation name, persisted hash or document, but values inside
  GET `variables` are traced only as the whole query value, and an operation whose type neither
  the capture nor the site's code shows stays `unknown` (probe skips it). GraphQL subscriptions
  over WebSockets are documented as channels, not split by operation.
- Dispatcher endpoints are split only on evidence (different parameters or response shapes per
  value); functions the capture never called are not listed, and POST functions are not probed
  unless `--unsafe-methods`.
- Interactive capture (closing the window to finish) is covered by an abort test but not by an
  automated headful test.

## Contributing and docs

[CONTRIBUTING.md](CONTRIBUTING.md) · [Architecture](docs/architecture.md) ·
[Decision records](docs/decisions/README.md) · [Security policy](SECURITY.md)

## Licence

[MIT](LICENSE)
