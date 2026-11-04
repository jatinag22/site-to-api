# Changelog

All user-visible changes to `site-to-api` and `site-to-api-runtime`, which share one version.
Versioning follows [docs/release-policy.md](docs/release-policy.md).

## Unreleased

### Added

- **Build from some sessions only.** `build --session <id>` (repeatable, `*` globs, config
  `build.sessions`) analyses only the named sessions in the raw folder, for example the captures of
  one site when the folder holds several. A name that matches no session is an error that lists
  the sessions there are. `probe` reuses the choice from `build.json`.
- **The agent skill ships in the package.** Projects that install from npm have it at
  `node_modules/site-to-api/skills/site-to-api/SKILL.md`, and `site-to-api --help` ends with its
  path. `init --agent` copies it into `.claude/skills/` and `.agents/skills/` and adds a pointer
  line to an existing `AGENTS.md` or `CLAUDE.md`; it never overwrites a copy or file you edited.
  Run without a terminal (by an agent or a script), `capture` and `build` also print the path.
- **CLI rules in `AGENT.md`.** A Commands section at the end says what an agent running the CLI
  must know: session ids must be new (reusing one is an error, never an overwrite), `build` reads
  every session unless `--session` narrows it, `--include`/`--exclude` choose hosts, `probe` and
  `check` replay against the live site and need a login that is still valid, the per-site MCP
  server is off unless `--mcp`, and `site-to-api mcp` serves the folder.

### Changed

- **The skill states the CLI's rules.** New session ids, `build --session`, host filters, expired
  logins for `probe` and `check`, and `gen.mcp` being off by default.

### Fixed

- **Dialogs during capture.** In a capture by hand, Chrome now shows `alert()`, `confirm()`,
  `prompt()` and "Leave site?" dialogs for you to answer. Before, every one was dismissed, so a step
  behind "Are you sure?" was silently cancelled and its request never captured. Capture scripts
  keep Playwright's default (`page.on('dialog', dialog => dialog.accept())` accepts) and get a
  warning when a confirmation was dismissed. Each dialog and its answer is recorded in
  `events.jsonl`; the text typed into a prompt is not.
- **Endpoints a navigation menu links to stay separate operations.** Controller and method names
  in lowerCamelCase (`/portal/accountLedger/home`, `/portal/serviceRecordNew/loadServiceRecord`)
  are no longer merged into `/portal/{param1}/{param2}`, and an XHR is never merged into a
  template of pages, even when it failed (decision 0060).
- **An endpoint seen only in a site's code is listed under one host.** On a site that sends no
  `Referer`, or for a route in an inline script, a relative route was listed under every host
  that served pages. It now goes to the page that loaded the script, the script's own site or
  the only site; when the capture cannot tell, a build warning names it instead (decision 0061).
- **A session with no requests no longer counts.** A capture whose browser was closed before any
  page loaded is still saved, now with a warning; `build` skips it with a warning that names it,
  and "Loaded N sessions" counts only the sessions it used.
- **Personal data in response records is masked like request fields.** With `--examples masked`,
  a profile answer kept the person's name, gender, national and account numbers, the visible
  digits of values the site had partly masked (`XXXX XXXX 1234`), and tokens in the query of a
  same-site URL (`/verify?state=…`); a typed captcha answer stayed in form examples. All are
  now masked in place, keeping their format, as are special-category fields (disability,
  health, medical, blood group, religion, caste, nationality, and a category inside a person
  record). Values in a person record never become a schema `enum` (decision 0063).
- **The session count after a capture skips empty sessions.** "Capture again for a second
  sample" now counts only sessions `build` would use, not a session whose browser was closed
  before any page loaded.
- **Method names in PascalCase, kebab-case and snake_case stay separate operations.** A menu
  linking to `/Orders/GetOrders` and `/Orders/LoadDetails`, or `/orders/get-orders` and
  `/orders/load-details`, no longer merges them into one template when they start with a verb
  (decision 0060).
- **A service's health check stays readable.** `health: "UP"`, `healthCheck: "ok"` and other
  health-check values outside a person record are no longer masked; a person's health status
  still is (decision 0063).

## 0.1.2 (2026-11-03)

The first release on npm (0.1.0 was published by hand; 0.1.1 was tagged on GitHub but never
reached npm). Everything below is new.

### Added

#### Capture and import

- **Record a browsing session in a real browser.** `capture` opens Google Chrome (Playwright's
  bundled Chromium where Chrome is missing, with a note) and records requests, responses, call
  stacks, crypto and encoding calls, typed input, WebSocket frames, server-sent events, scripts and
  sourcemaps until you close the browser or press Ctrl+C. Every way of finishing saves the session.
- **Scripted, minimized and logged-in captures.** `--script` drives the browser from a file;
  `--minimized` keeps a normal browser out of the way; `--headless` runs without a window;
  `--user-data-dir` reuses a browser profile, so a person logs in once and later captures run
  logged in. A failing script still saves the session, marked incomplete.
- **Import a HAR instead of capturing.** `import <file.har>` turns a HAR from browser DevTools or a
  proxy into a raw session; `--delete-source` deletes the HAR afterwards, since it holds your
  cookies. A HAR without cookies or `Authorization` headers gets a warning that names Chrome's
  "Export HAR (with sensitive data)".

#### Analysis and output

- **A handoff folder for coding agents.** `build` writes OpenAPI 3.1 specs, AsyncAPI 3.0 specs for
  channels, `flows.json` and `flows.md`, `API_MAP.md`, a short `AGENT.md` index with one file per
  host, `GAPS.md`, and Markdown excerpts of the site's own code. The output is deterministic: the
  same captures give byte-identical files, and no LLM runs inside the tool.
- **Value origins.** Every request input is traced to where its value comes from: an earlier JSON
  response, header, cookie or HTML selector, a value computed by the page's code (with the source
  location and excerpt), typed input, a constant, or a cookie set by a page script.
- **Protocols beyond plain JSON.** GraphQL operations (one per query or mutation, persisted queries
  included), tRPC, Connect, and dispatcher endpoints (`action=`, `functionName=`, JSON-RPC
  `method`) each become one operation per function. WebSocket and event-stream channels are
  decoded for Socket.IO, SockJS, SignalR, STOMP, graphql-ws, Phoenix, Centrifugo, Firebase Realtime
  Database, Primus, SmartFoxServer 2X, MessagePack and protobuf.
- **Records from pages.** HTML tables, repeated elements and CSV or text responses get extraction
  specs verified against the captured samples, and values such as CSRF tokens are read from HTML.
- **Bot protection is recorded, never bypassed.** Akamai, AWS WAF, Cloudflare, DataDome, Imperva,
  Kasada, PerimeterX and captchas are detected and documented as steps that need a real browser.
- **Redaction and a leak check.** The handoff folder masks cookie values, tokens, tracking IDs and
  personal data by default (`--examples masked`). When a secret the redactor learnt still appears
  in the files a build wrote, the build fails and deletes those files. Raw captures stay in a
  gitignored folder.

#### Generated client and runtime

- **A typed TypeScript client.** `build` (and `gen`, from the handoff folder alone) writes a hey-api
  SDK with Zod Mini schemas, wired to `site-to-api-runtime`. `createSiteClient` returns a client of
  its own per call, so one per user never shares cookies or credentials; per-host factories in
  `<host>/site.ts` keep bundles small. HTML and text responses get typed parsers.
- **The client can live in your app.** `gen.clientDir` puts it in your source tree; `gen` replaces
  only the files it generated, keeps your own files, and reports hand edits until `--force`.
- **`site-to-api-runtime`.** A cookie jar (RFC 6265, saved with `toJSON()`), `fetch` with retries
  and `Retry-After`, cookie, token and browser-backed sessions, and HTML or text extraction. It
  uses only web-standard APIs and runs on Node, Bun and edge workers; its `browser` build
  bundles no HTML parser.

#### Live checks

- **`probe`** replays captured requests (1 per second, safe methods and GraphQL queries unless
  `--unsafe-methods`) to find the cookies and headers plain HTTP needs, and folds the results into
  the docs and the client.
- **`check`** replays safe requests and reports API drift against the response schemas, with exit
  codes for CI (0 no drift, 1 drift, 2 could not check) and `check.json` with field paths only.

#### Agents

- **MCP servers.** `site-to-api mcp` serves the handoff folder to an agent with read-only tools,
  plus `call_operation` under probe's rules with `--allow-calls`. `--mcp` writes a per-site MCP
  server with one tool per operation. Both run only a client this machine generated.
- **Claude Code plugin and agent skill.** The repository is a plugin marketplace with capture,
  build, probe and check commands and a skill for any agent that reads Agent Skills. The plugin
  runs the globally installed CLI (`npm install -g site-to-api`), never a copy from the opened
  project.

#### Configuration

- **Layered configuration.** `init` writes `site-to-api.config.ts`; values come from CLI flags,
  `SITE_TO_API_*` variables, the config file and defaults, and `config` shows where each came from.
  The options of the last `build` are recorded in `build.json` and reused by `probe` and `gen`.

### Changed

For clients generated by builds from source before this release; `gen` warns once when it
rewrites one:

- **Operations are called through the `sdk` that `createSiteClient` returns.** Each call creates
  its own client; the host namespaces exported from `index.ts` throw when called without
  `{ client }` instead of sending a request without your session.
- **Schemas are Zod Mini.** Use `z.optional(schema)` instead of `schema.optional()`; `.parse` still
  works.
- **The MCP server moved from `client/mcp/` to `mcp/` next to the client.** Delete the old folder.
- **Your own files in the client folder are kept,** and hand edits to generated files are reported
  instead of overwritten.

### Known issues

- **Not decoded:** fetch streams that never end, zstd request bodies, binary Connect bodies,
  gRPC-web, tRPC over WebSocket and encrypted SmartFoxServer packets.
  [docs/limitations.md](docs/limitations.md) lists the other known limits.

### Deliberate omissions

- **No bot-protection bypass of any kind:** no stealth plugins, fingerprint patching, challenge
  solving or sensor payload generation. Such features will not be added
  ([docs/responsible-use.md](docs/responsible-use.md)).
