# site-to-api

[![CI](https://github.com/jatinag22/site-to-api/actions/workflows/ci.yml/badge.svg)](https://github.com/jatinag22/site-to-api/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
![Node 22.12+](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg)

**Record one browsing session of a website. Get the OpenAPI specs, request flows and typed client
a coding agent needs to build a wrapper for its internal API.**

![Demo: a scripted capture, the build, and the AGENT.md it writes](docs/assets/demo.gif)

`site-to-api` is for developers who need to integrate with a website that has no public API,
usually with a coding agent writing the code. Use it only on sites you are allowed to use; it never
bypasses bot protection, captchas or access controls.

It records what a site's own pages do while you use it (or reads a HAR you already have), then
works out the endpoints, their schemas, the order requests happen in, which value feeds which
request, and what a session needs. It writes one folder: OpenAPI 3.1 and AsyncAPI 3.0 specs,
request flows, a short `AGENT.md` for your coding agent, excerpts of the site's own code, and a
typed TypeScript client with Zod validation.

No LLM runs inside the tool: the same capture gives byte-identical output, and your coding agent
does the reasoning on top of it. Each request input is traced to its origin, such as a CSRF token
in a meta tag, an ID from an earlier response, or a password encrypted in the browser by
`encryptPassword()` in the site's own `src/auth/crypto.ts`, recovered from its sourcemaps. Raw
captures stay in a gitignored folder; the handoff folder is redacted, and a leak check fails the
build if a secret learnt from the capture slipped through. Bot protection is recorded as "needs a
real browser"; `probe` measures what plain HTTP needs, and `check` reports when the API drifts.

## Quick start

Requires Node 22.12 or later.

```sh
npm init -y                              # if this folder has no package.json yet
npm install -D site-to-api               # the CLI, a development dependency
npx site-to-api init                     # config file, and a gitignore for raw captures
npx site-to-api capture https://example.com
#   a browser window opens: use the site the way your wrapper will (log in, search, open pages),
#   then close the window (or press Ctrl+C here) to finish
npx site-to-api build                    # writes api-handoff/
npx site-to-api probe                    # optional: what plain HTTP needs (read-only requests, 1 per second)
```

Then give your coding agent a task such as:

> Read `api-handoff/AGENT.md` and write `src/shop.ts`: a function that logs in and returns my
> orders, using the generated client in `api-handoff/client/`.

Commit `api-handoff/`. Never commit `.site-to-api/`: it holds the raw captures, with your real
cookies and tokens.

`capture` opens Google Chrome. Where Chrome is not installed it uses Playwright's bundled
Chromium instead and says so; download that once with `npx playwright install chromium`. Pass
`--channel chrome` (or `msedge`, or `bundled`) to require one browser. A second capture of the same
pages (`--session second-pass`) gives the build two samples to compare.

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
  mcp/                only with --mcp: an MCP server with one tool per operation
  GAPS.md, build.json, probe.json, check.json
```

`AGENT.md` stays short on any site (under about 25 KB). An excerpt from the fixture shop below,
whose toy bot protection imitates Akamai's cookie names, so the build reports it as Akamai:

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

| Kind | Supported |
|---|---|
| APIs | GraphQL (one operation per query or mutation, persisted queries included), tRPC, Connect, dispatcher endpoints where one parameter picks the function (`action=`, `functionName=`, JSON-RPC `method`) |
| Real-time | WebSocket and server-sent event channels; Socket.IO, SockJS, SignalR, STOMP, graphql-ws, Phoenix, Centrifugo, Firebase Realtime Database, Primus and SmartFoxServer 2X framing; MessagePack and protobuf binary frames |
| Pages | Records in HTML pages (table rows, repeated elements) and CSV or text responses, as typed parsers; values such as CSRF tokens read from HTML |
| Bot protection | Akamai, AWS WAF, Cloudflare (Turnstile included), DataDome, Imperva, Kasada, PerimeterX and captchas, recorded as browser-only steps |

## Responsible use

Use it to integrate with services you are allowed to use, respect terms of use and rate limits,
and prefer an official API when one exists. The tool never defeats bot protection, captchas or
access controls, and never hides that the browser is automated. See
[docs/responsible-use.md](docs/responsible-use.md).

## Try it on the fixture shop first

The repository includes Pinewood Market, a fictional shop the end-to-end tests run against: a login
with a browser-encrypted password, a CSRF token, toy bot protection, GraphQL, HTML tables, a CSV
export and WebSockets. Running it needs a clone and pnpm (`corepack enable`):

```sh
# terminal 1: the shop on http://localhost:4173
git clone https://github.com/jatinag22/site-to-api ~/site-to-api
cd ~/site-to-api && pnpm install
pnpm --filter @site-to-api/e2e run fixture
```

```sh
# terminal 2: three scripted sessions, then build
mkdir ~/pinewood && cd ~/pinewood
npm init -y && npm install -D site-to-api
npx playwright install chromium        # the scripted runs use Playwright's Chromium
npx site-to-api init
for s in browse browse-again login; do
  npx site-to-api capture http://localhost:4173 --headless --channel bundled --session $s \
    --script ~/site-to-api/e2e/scenarios/$s.ts
done
npx site-to-api build                  # 27 operations, 20 flows → ./api-handoff
npx site-to-api probe                  # optional: checks the session needs against the shop
```

The 27 operations are the 18 API operations, 8 pages and 1 bot-protection step that `AGENT.md`
lists for the shop. The shop's test account is `demo` / `demo-password` (fictional, local only).

## Capture

`capture` records everything the pages do until you close the last tab or window, quit the
browser, or press Ctrl+C; each saves a complete session to `.site-to-api/raw/<session>/`.

| Situation | Command |
|---|---|
| By hand, in a normal browser | `npx site-to-api capture https://example.com` |
| Repeatable, driven by a script | `npx site-to-api capture https://example.com --script capture.ts` |
| Scripted, without taking over the screen | add `--minimized`: a normal browser whose windows stay minimized |
| Scripted, no window at all | add `--headless`; sites with bot protection usually block it, so prefer `--minimized` |
| Logged in | add `--user-data-dir .site-to-api/profile`: a person logs in once, later captures reuse the login |

Capture scripts, logged-in captures with a saved profile, and what happens when a script fails:
[docs/capture.md](docs/capture.md).

## Import a HAR instead of capturing

Export one from your browser's DevTools (Network tab) or a proxy (Charles, mitmproxy). In Chrome,
use "Export HAR (with sensitive data)": the default export leaves out cookies and `Authorization`
headers, so the build cannot show how the site signs you in (turn the option on under DevTools
settings, Network, "Allow to generate HAR with sensitive data").

```sh
npx site-to-api import session.har --delete-source   # a raw session, like a capture
npx site-to-api build
```

A HAR holds the traffic only: an imported session has no values computed in the browser, no typed
inputs and, unless the HAR has them, no call stacks or scripts. `AGENT.md` lists what is missing.
The HAR holds your cookies, so `--delete-source` deletes it once it is imported.

## Use the generated client in an app

Set `gen: { clientDir: 'src/site-client' }` in `site-to-api.config.ts` to put the client in your
app's source tree. Each `createSiteClient` call is a client of its own, so one per user never
shares cookies or credentials, and each host's `site.ts` factory keeps bundles small. Commit the
client and handoff folders; never commit `.site-to-api/`, a saved cookie jar or credentials.
Project setup, a complete wrapper for the fixture shop, and where the client runs:
[docs/using-the-client.md](docs/using-the-client.md).

## Use with AI agents (MCP)

`npx site-to-api mcp ./api-handoff` serves the handoff folder to an agent over MCP, so it can look
up one operation at a time instead of reading every spec. `build --mcp` also writes a server for
the site with a tool for each operation that only reads data; `--mcp write` adds tools for the
operations that change data. The repository is also a Claude Code plugin marketplace
(`claude plugin marketplace add jatinag22/site-to-api`). Tools, live calls, the trust check and the
plugin: [docs/mcp.md](docs/mcp.md).

## Probe and check

`probe` replays captured requests against the live site to learn which cookies and headers plain
HTTP needs; `check` replays them to report drift from the response schemas, with exit codes for
CI (0 no drift, 1 drift, 2 could not check). Both send read-only requests at 1 per second by
default and never replay a bot-protection step. Details and a scheduled drift check:
[docs/probe-and-check.md](docs/probe-and-check.md).

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

From each project's README (for browser-to-api, its `SKILL.md`) as of November 2026. A dash means
the README does not say.

| | site-to-api | site2api | browser-to-api | reverse-api-engineer | mitmproxy2swagger | har-to-openapi |
|---|---|---|---|---|---|---|
| Input | browser capture or HAR | browser capture or HAR | `browser-trace` capture | browser capture | mitmproxy flow or HAR | HAR |
| Who drives the browser | you or your script | you | - | you, or an AI agent | - | - |
| LLM in the pipeline | no | optional (`infer`, for names) | no (offline Node scripts) | yes, it writes the client | - | - |
| Specs | OpenAPI 3.1, AsyncAPI 3.0 | - | OpenAPI 3.1 | - | OpenAPI 3.0 | OpenAPI 3.0 or 3.1 |
| Client | TypeScript with Zod | MCP server | JavaScript | Python, JavaScript, TypeScript, Go, Java, C#, PHP, Ruby, C, PowerShell | - | - |
| Other output | flows, agent docs, code excerpts, MCP servers | report | HTML and Markdown reports | - | - | conversion report |
| Where input values come from | traced, with code locations | inferred (such as item IDs) | - | - | - | - |
| GraphQL and JSON-RPC split per operation | yes | - | yes | - | - | - |
| Live checks against the site | `probe` (needs), `check` (drift) | `verify` (read tools) | - | - | - | - |
| Secrets in output | redacted by default, leak check | checked against fingerprints of captured credentials | best-effort redaction | - | examples and headers only on request | configurable redaction |

Projects: [site2api](https://github.com/flyingsquirrel0419/site2api),
[browser-to-api](https://github.com/browserbase/skills/tree/main/skills/browser-to-api)
(Browserbase), [reverse-api-engineer](https://github.com/kalil0321/reverse-api-engineer),
[mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger),
[har-to-openapi](https://github.com/jonluca/har-to-openapi).

## Limitations

The ones a first run is most likely to meet; the full list is in
[docs/limitations.md](docs/limitations.md).

- With npm, a project that has TypeScript 7 installed cannot run the CLI: the client generator's
  `typescript` dependency resolves to the project's TypeScript 7, whose API it does not support.
  Install `typescript@6` in the project until this is fixed.
- Redaction and value tracing are heuristics. Personal data with no telling field name or shape
  (a name in a free-text bio) can get through. Review the handoff folder before publishing it.
- From one session, HTML and text extraction is low confidence and no field becomes an enum;
  capture the same pages a second time.
- An imported HAR cannot explain values the page computed; capture the same pages for that.

## Contributing and docs

[CONTRIBUTING.md](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) ·
[Release policy](docs/release-policy.md) · [Architecture](docs/architecture.md) ·
[Output format](docs/output-format.md) · [Configuration](docs/configuration.md) ·
[Capture](docs/capture.md) · [Using the client](docs/using-the-client.md) · [MCP](docs/mcp.md) ·
[Probe and check](docs/probe-and-check.md) · [Limitations](docs/limitations.md) ·
[Decision records](docs/decisions/README.md) · [Testing](docs/testing.md) ·
[Maintaining](docs/maintaining.md) · [Security policy](SECURITY.md)

## Licence

[MIT](LICENSE)
