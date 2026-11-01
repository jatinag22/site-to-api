# site-to-api

[![CI](https://github.com/jatinag22/site-to-api/actions/workflows/ci.yml/badge.svg)](https://github.com/jatinag22/site-to-api/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/site-to-api.svg)](https://www.npmjs.com/package/site-to-api)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
![Node 22.12+](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg)

**Browse a website once. Get everything a coding agent needs to build a wrapper for its internal
API.**

![A scripted login capture on the fixture shop, then build, then the session needs and the computed password from AGENT.md](docs/assets/demo.gif)

`site-to-api` records what a site's own pages do while you use it (or reads a HAR you already
have), then works out the endpoints, their schemas, the order requests happen in, which value
feeds which request, the browser code that computes values like encrypted passwords, and what a
session needs. It writes one folder: OpenAPI 3.1 and AsyncAPI 3.0 specs, request flows, a short
`AGENT.md` for your coding agent, excerpts of the site's own code, and a typed TypeScript client
with Zod validation.

What sets it apart:

- **No LLM inside.** The same capture gives byte-identical output; your coding agent does the
  reasoning on top of it.
- **Every input has an origin.** A CSRF token from a meta tag, an ID from an earlier response, a
  password encrypted by `encryptPassword()` in `src/auth/crypto.ts:26`: each is traced and linked
  to the code.
- **Secrets stay local.** Raw captures live in a gitignored folder. The handoff folder is
  redacted, and a leak check fails the build if a secret learnt from the capture slipped through.
- **Honest about sessions.** Bot protection is detected and recorded as "needs a real browser",
  never bypassed. `probe` measures what plain HTTP needs; `check` reports when the API drifts.

## Quick start

Requires Node 22.12 or later.

```sh
npm install -D site-to-api               # the CLI, a development dependency
npx site-to-api init                     # config file, and a gitignore for raw captures
npx site-to-api capture https://example.com
#   a browser window opens: use the site the way your wrapper will (log in, search, open pages),
#   then close the window (or press Ctrl+C here) to finish
npx site-to-api capture https://example.com --session second-pass   # optional: a second sample
npx site-to-api build                    # writes api-handoff/
npx site-to-api probe                    # optional: what plain HTTP needs (1 request/s, GET only)
```

Then point your coding agent at `api-handoff/AGENT.md`.

`capture` opens Google Chrome. Where Chrome is not installed it uses Playwright's bundled
Chromium instead and says so; download that once with `npx playwright install chromium`. Pass
`--channel chrome` (or `msedge`, or `bundled`) to require one browser.

The generated client runs in your app with two runtime dependencies:

```sh
npm install @site-to-api/runtime zod
```

> [!NOTE]
> If your project has TypeScript installed, use TypeScript 6 for now (`npm install -D
> typescript@6`). With npm, TypeScript 7 in the project stops the CLI from starting (see
> [Limitations](#limitations)).

## What you get

```
api-handoff/
  AGENT.md            start here: hosts, what each session needs, key flows, top gaps
  hosts/<host>.md     everything about one host: cookies, bot protection, operations, channels
  API_MAP.md          one row per operation: inputs and where each value comes from
  flows.json          request flows and value origins (flows.md is the readable copy)
  specs/<host>.yaml   OpenAPI 3.1; <host>.asyncapi.yaml for WebSocket and event-stream channels
  source/             excerpts of the site's own code that the docs point to
  client/             typed client (hey-api SDK + Zod), unless gen.clientDir puts it in your app
  GAPS.md, build.json, probe.json, check.json
```

`AGENT.md` stays short on any site (under about 25 KB). An excerpt from the fixture shop:

```markdown
- `localhost:4173`: a real browser sets up the session (confirmed by probe); bot protection:
  Akamai (cookie \_abck; cookie bm\_sz; request body matches sensor\_data); 18 API operations
  (1 seen in code only), 8 pages, 1 bot-protection step, 3 channels, 19 gaps.

## Values computed in the browser

- `body./password` of `postApiAuthLogin`: `src/auth/crypto.ts:26 encryptPassword` using
  `crypto.subtle.encrypt` (name=RSA-OAEP); it uses `body./publicKey` from `getApiAuthKey`, the
  `password` field.
```

Every file is specified in [docs/output-format.md](docs/output-format.md).

What `build` understands beyond plain JSON over HTTP:

- **APIs:** GraphQL (one operation per query or mutation, persisted queries included), tRPC,
  Connect, and dispatcher endpoints where one parameter picks the function (`action=`,
  `functionName=`, JSON-RPC `method`).
- **Real-time:** WebSocket and server-sent event channels, with Socket.IO, SockJS, SignalR, STOMP,
  graphql-ws, Phoenix, Centrifugo, Firebase Realtime Database, Primus and SmartFoxServer 2X
  framing, and MessagePack and protobuf binary frames.
- **Pages:** records in HTML pages (table rows, repeated elements) and in CSV or text responses,
  turned into typed parsers; values such as CSRF tokens read from HTML.
- **Bot protection:** Akamai, AWS WAF, Cloudflare (Turnstile included), DataDome, Imperva, Kasada,
  PerimeterX and captchas, recorded as browser-only steps.

## Try it on the fixture shop first

The repository includes Pinewood Market, a fictional shop the end-to-end tests run against: a login
with a browser-encrypted password, a CSRF token, toy bot protection, GraphQL, HTML tables, a CSV
export and WebSockets. Running it needs a clone and pnpm (`corepack enable`):

```sh
# terminal 1: the shop on http://localhost:4173
git clone https://github.com/jatinag22/site-to-api && cd site-to-api
pnpm install
pnpm --filter @site-to-api/e2e run fixture
```

```sh
# terminal 2: three scripted sessions, then build
REPO=~/site-to-api                     # the folder you cloned into
mkdir pinewood && cd pinewood
npm init -y && npm install -D site-to-api
npx playwright install chromium        # the scripted runs use Playwright's Chromium
npx site-to-api init
for s in browse browse-again login; do
  npx site-to-api capture http://localhost:4173 --headless --channel bundled --session $s \
    --script "$REPO/e2e/scenarios/$s.ts"
done
npx site-to-api build                  # 27 operations, 20 flows → ./api-handoff
npx site-to-api probe                  # optional: checks the session needs against the shop
```

The shop's test account is `demo` / `demo-password` (fictional, local only).

## Capture

`capture` records everything the pages do until you finish: close the last tab or window, quit the
browser, or press Ctrl+C. All three save a complete session to `.site-to-api/raw/<session>/`.

| Situation | Command |
|---|---|
| By hand, in a normal browser | `npx site-to-api capture https://example.com` |
| Repeatable, driven by a script | `npx site-to-api capture https://example.com --script capture.ts` |
| Scripted, without taking over the screen | add `--minimized`: a normal browser whose windows stay minimized |
| Scripted, no window at all | add `--headless`; sites with bot protection usually block it, so prefer `--minimized` |
| Logged in | add `--user-data-dir .site-to-api/profile` (see below) |

A capture script exports one function that receives Playwright's `page`:

```ts
// capture.ts
import type { Page } from 'playwright'

export default async ({ page, baseUrl }: { page: Page, baseUrl: string }) => {
  await page.goto(baseUrl)
  await page.getByRole('link', { name: 'Deals' }).click()
  await page.waitForLoadState('networkidle')
}
```

A failing script, or Ctrl+C during one, still saves the session, marked incomplete, and exits 1.

### Logged-in captures with a saved profile

A browser profile keeps cookies between captures, so a person logs in once and later scripted
captures run logged in. The script never types a password and never meets a captcha:

```sh
# 1. The person logs in by hand (solving any captcha), browses a little, closes the browser
npx site-to-api capture https://example.com --user-data-dir .site-to-api/profile --session login

# 2. Later captures reuse that login, for example scripted and minimized
npx site-to-api capture https://example.com --user-data-dir .site-to-api/profile \
  --minimized --script capture.ts
```

Use a dedicated folder, not your everyday browser profile, and the same browser both times. The
profile holds a live login: keep it under `.site-to-api/`, which `init` gitignores. A login the
site keeps only in session storage or in cookies that end with the browser does not survive; when
the login is gone or expired, repeat step 1.

## Already have a HAR?

Export one from your browser's DevTools (Network tab) or a proxy (Charles, mitmproxy) and import it
instead of capturing. In Chrome, use **Export HAR (with sensitive data)**: the default export leaves
out cookies and `Authorization` headers, so the build cannot show how the site signs you in (turn
the option on under DevTools settings, Network, "Allow to generate HAR with sensitive data").

```sh
npx site-to-api import session.har --delete-source   # a raw session, like a capture
npx site-to-api build
```

A HAR holds the traffic only: an imported session has no values computed in the browser, no typed
inputs and, unless the HAR has them, no call stacks or scripts. `AGENT.md` lists what is missing.
The HAR holds your cookies, so `--delete-source` deletes it once it is imported.

## Use the generated client in an app

Put the client in your app's source tree with `gen.clientDir`, and keep the handoff folder beside
it:

```ts
// site-to-api.config.ts
import { defineConfig } from 'site-to-api'

export default defineConfig({
  gen: { clientDir: 'src/site-client' }, // default: api-handoff/client
})
```

`build` (or `gen`, which regenerates only the client) writes the client there, and the MCP server,
when you ask for one, to `src/mcp/` next to it. Each `createSiteClient` call is a client of its
own, so one per user or account never shares cookies or credentials:

```ts
import { CookieJar, createSiteClient } from './site-client/index.js'

let token: string | undefined // for example from the login response
const { sdk } = createSiteClient({
  host: 'shop.example.com',
  jar: new CookieJar(), // save with jar.toJSON(), restore with CookieJar.fromJSON()
  auth: () => token && `Bearer ${token}`, // sent to operations the spec marks as secured
})
const { data, error } = await sdk.getApiOrders({})
```

For small bundles, import one host's factory and only the functions you call:

```ts
import { createShopExampleComClient, getApiOrders } from './site-client/shop_example_com/site.js'

const { client } = createShopExampleComClient({
  jar: new CookieJar()
})
const { data } = await getApiOrders({ client })
```

- **Sessions:** plain cookies by default; `tokenSession` for a token with refresh;
  `browserSession` when a host needs a real browser (bot protection): it loads the site with
  Playwright and reuses its cookies for plain HTTP.
- **What to commit:** the client folder and the handoff folder (both redacted). Never commit
  `.site-to-api/`, a saved cookie jar or credentials.
- **Where it runs:** Node, Bun and Deno fully; edge workers over plain HTTP, with the jar kept in
  the platform's storage; in a browser only on the site's own origin (an extension or userscript),
  since CORS blocks it anywhere else.
- **Your own files** in the client folder are kept, and a generated file you edited is kept and
  reported until `--force` overwrites it.

The generated `client/README.md` says what each host's session needs and how to pass `auth`.
[docs/using-the-client.md](docs/using-the-client.md) has the project setup, a complete wrapper for
the fixture shop (login with an encrypted password, CSRF token, bot-protection cookies) and the
GraphQL and dispatcher calls.

## Use with AI agents (MCP)

Two MCP servers, both over stdio. Details and the security model: [docs/mcp.md](docs/mcp.md).

**Explore the handoff folder.** `site-to-api mcp` lets an agent look up one operation at a time
instead of reading every spec. It reads only the redacted handoff folder, never raw captures, and
runs no project code.

```sh
claude mcp add site-api -- npx site-to-api mcp ./api-handoff
```

Tools: `list_hosts`, `search_operations`, `get_operation`, `get_flow`, `get_examples`,
`get_source`. `--allow-calls` adds `call_operation`, which sends live requests under probe's rules
(safe methods, rate limited, credentials only from environment variables you set).

**A server for one site.** `build --mcp` (or `gen --mcp`) writes an MCP server with one tool per
operation that only reads; `--mcp write` adds the ones that change data. Serve it through the CLI,
which first checks that this machine generated the client:

```sh
claude mcp add pinewood -e SITE_API_COOKIE='…' -- npx site-to-api mcp ./api-handoff --generated
```

### Claude Code plugin and agent skill

The repository is a Claude Code plugin marketplace. The plugin adds the exploration server above,
the commands `/site-to-api:capture`, `/site-to-api:build`, `/site-to-api:probe` and
`/site-to-api:check`, and a skill that walks an agent through capture, reading the handoff folder,
writing the wrapper and the safety rules.

```sh
claude plugin marketplace add jatinag22/site-to-api
claude plugin install site-to-api@site-to-api
```

The plugin's MCP server starts `site-to-api` from your `PATH`, so it needs a global install
(`npm install -g site-to-api`); the commands use the project's copy through `npx`. For other agents
that read Agent Skills (Cursor, Codex and others), the same skill is
[`skills/site-to-api/SKILL.md`](skills/site-to-api/SKILL.md):
`npx skills add jatinag22/site-to-api -s site-to-api`.

## Probe and check

`probe` replays captured requests against the live site to learn which cookies and headers plain
HTTP really needs, then rebuilds the handoff folder with the options of the last `build`. It sends
1 request per second, safe methods and GraphQL queries only unless you pass `--unsafe-methods`,
and never replays a bot-protection step.

`check` replays the safe requests and compares each answer with the operation's response schema:
status changes, added fields, missing required fields, type changes. It writes `check.json` (field
paths only, never values) and exits 0 for no drift, 1 for drift and 2 when it could not check, so
it fits in CI or cron:

```sh
npx site-to-api check                                    # the site's own hosts
npx site-to-api check --operations getApiProducts,getApiCategories
npx site-to-api check --json                             # check.json on stdout
```

Both need the raw captures, which hold cookies. A scheduled drift check that keeps them in a
private repository: [docs/probe-and-check.md](docs/probe-and-check.md).

## Commands

| Command | What it does |
|---|---|
| `init` | Writes `site-to-api.config.ts` and gitignores `.site-to-api/` |
| `capture [url]` | Records a browsing session. `--script <file>`, `--minimized`, `--headless`, `--channel <name>`, `--user-data-dir <dir>`, `--session <id>` |
| `import <file.har>` | Turns a HAR into a raw session. `--session <id>`, `--delete-source` |
| `build` | Analyses every session and writes the handoff folder and the client. `--include/--exclude <host>`, `--examples masked\|raw\|none`, `--no-client`, `--mcp [read\|write\|off]`, `--force` |
| `probe` | Replays requests to learn what plain HTTP needs, then rebuilds. `--max-rps <n>`, `--unsafe-methods`, `--minimize-per-host <n>`, and the output flags of `build` |
| `check` | Detects API drift. `--include/--exclude <host>`, `--operations <ids>`, `--max-rps <n>`, `--json` |
| `gen` | Regenerates only the client (and the MCP server) from the handoff folder, without raw captures. `--mcp [read\|write\|off]`, `--force` |
| `mcp [dir]` | Serves the handoff folder over MCP. `--allow-calls`, `--unsafe-methods`, `--max-rps <n>`, `--generated`, `--trust-client` |
| `config` | Prints the resolved config and where each value came from. `--json` |

Every command takes `-c, --config <file>`, `--cwd <dir>`, `--raw-dir <dir>` and `--out-dir <dir>`;
`npx site-to-api <command> --help` describes each flag.

## Configuration

Settings come from CLI flags, then `SITE_TO_API_*` environment variables, then
`site-to-api.config.ts` (or `.json`), then defaults. Unknown keys are errors, and
`npx site-to-api config` shows which source set each value. Every key, its default and its
variable: [docs/configuration.md](docs/configuration.md).

The options a `build` ran with are recorded in `build.json`, so `probe` and `gen` reuse them
instead of undoing them.

## How it compares

From each project's README (for Browserbase's skill, its `SKILL.md`) as of November 2026. A dash
means the README does not say.

| | site-to-api | [site2api](https://github.com/flyingsquirrel0419/site2api) | [browser-to-api](https://github.com/browserbase/skills/tree/main/skills/browser-to-api) (Browserbase) | [reverse-api-engineer](https://github.com/kalil0321/reverse-api-engineer) | [mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger) | [har-to-openapi](https://github.com/jonluca/har-to-openapi) |
|---|---|---|---|---|---|---|
| Input | browser capture or HAR | browser capture or HAR | a `browser-trace` capture | browser capture, by you or an agent | mitmproxy flow or HAR | HAR |
| LLM in the pipeline | no | optional (`infer`, for names) | - | yes, it writes the client | - | - |
| Output | OpenAPI 3.1, AsyncAPI, flows, agent docs, TS client with Zod, MCP servers | MCP server, report | OpenAPI 3.1, HTML report, JS client | client in 10 languages | OpenAPI 3.0 | OpenAPI |
| Where input values come from | traced, with code locations | inferred (such as item IDs) | - | - | - | - |
| GraphQL and JSON-RPC split per operation | yes | - | yes | - | - | - |
| Live checks against the site | `probe` (needs), `check` (drift) | `verify` (read tools) | - | - | - | - |
| Secrets in output | redacted by default, leak check | captured credential values excluded | best-effort redaction | - | examples only on request | configurable redaction |

## Responsible use

Use it to integrate with services you are allowed to use, respect terms of use and rate limits,
and prefer an official API when one exists. The tool never defeats bot protection, captchas or
access controls, and never hides that the browser is automated. See
[docs/responsible-use.md](docs/responsible-use.md).

## Limitations

- With npm, a project that has TypeScript 7 installed cannot run the CLI: the client generator's
  `typescript` dependency resolves to the project's TypeScript 7, whose API it does not support.
  Install `typescript@6` in the project until this is fixed.
- Web Workers and Service Workers are not instrumented (their traffic is captured, without stacks).
- Redaction and value tracing are heuristics. Personal data with no telling field name or shape
  (a name in a free-text bio) can get through; the leak check searches only for values the
  redactor learnt, of 6 or more characters that mix letters and digits. Review the handoff folder
  before publishing it.
- HTML and text extraction from a single sample is low confidence; capture a second pass.
- An imported HAR cannot explain values the page computed; capture the same pages for that.
- GraphQL operations are split by operation name, persisted hash or document, but values inside
  GET `variables` are traced only as the whole query value, and an operation whose type neither
  the capture nor the site's code shows stays `unknown` (probe skips it). GraphQL subscriptions
  over WebSockets are documented as channels, not split by operation.
- Dispatcher endpoints are split only on evidence (different parameters or response shapes per
  value); functions the capture never called are not listed, and POST functions are not probed
  unless `--unsafe-methods`.
- An enum needs its values seen in at least two sessions; from one session a field stays a plain
  string.
- Path templating can merge two endpoints whose code-route parameter has a minified name and
  whose words also appear in page text (YouTube's `/youtubei/v1/{qsa}`), and a site whose own
  API host is named `analytics.*` or `telemetry.*` is ranked last.
- A learnt value inside a host name (`<user>.github.io`) is not templated; the leak check stops
  that build instead.
- Not decoded: fetch streams that never end, zstd request bodies, binary Connect bodies,
  gRPC-web, tRPC over WebSocket, encrypted SmartFoxServer packets.
- The generated code covers HTTP only; WebSocket channels are documented in AsyncAPI, to open with
  any WebSocket client.
- Interactive capture (closing the window to finish) is covered by an abort test but not by an
  automated headful test. In interactive mode a browser crash looks like quitting; both save a
  complete session with a note.
- Tested by hand on about 30 public sites logged out (see [docs/testing.md](docs/testing.md)) and
  on two logged-in sessions; other kinds of site may still show new problems.

## Contributing and docs

[CONTRIBUTING.md](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) ·
[Release policy](docs/release-policy.md) · [Architecture](docs/architecture.md) ·
[Output format](docs/output-format.md) · [Configuration](docs/configuration.md) ·
[Using the client](docs/using-the-client.md) · [MCP](docs/mcp.md) ·
[Probe and check](docs/probe-and-check.md) · [Decision records](docs/decisions/README.md) ·
[Testing](docs/testing.md) · [Maintaining](docs/maintaining.md) · [Security policy](SECURITY.md)

## Licence

[MIT](LICENSE)
