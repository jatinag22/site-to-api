# 0043 MCP servers: an exploration server for the handoff folder, and a generated one per site

Status: Accepted (2026-10-30). Builds on 0004, 0008, 0012, 0018, 0039.

## Context
A coding agent reading the handoff folder has to load `AGENT.md`, `API_MAP.md` and then whole
specs to find one operation; a site with a few hundred operations does not fit its context. MCP
lets the agent ask for one piece at a time. Once a wrapper exists, the same agent (or another
one) wants to call the site's operations as tools, which needs a server that knows the client.

## Decision
- **SDK.** The official TypeScript SDK, v2: `@modelcontextprotocol/server` (and
  `@modelcontextprotocol/client` for tests), pinned to an exact version (2.4.0) in the catalog.
  v2 replaced the single `@modelcontextprotocol/sdk` package (now the v1 maintenance line); the
  v2 server package depends only on `zod` and the SDK's own core, where v1 pulls in an HTTP
  stack (express, hono, cors, jose) the CLI would never use. It implements the 2026-07-28 spec.
  Upgrades are deliberate and covered by the e2e test, like hey-api (0010).
- **`site-to-api mcp [dir]`** serves a handoff folder over stdio. It reads `specs/`,
  `flows.json`, `build.json` and the files under `source/` only: never the raw captures, never
  `probe.json`, never `AGENT.md` prose. Tools: `list_hosts`, `search_operations` (words in id,
  method, path, summary, GraphQL name or dispatcher value; host and kind filters; paged),
  `get_operation` (spec slice without examples, each input with its origin, session needs, the
  client call), `get_flow`, `get_examples`, `get_source`. All are annotated read-only and
  closed-world.
- **No folder yet.** The server starts without a handoff folder (the Claude Code plugin enables
  it in every project): every tool then answers with an error that names the path and says to
  run `capture`, then `build`. The folder is read on the first call that finds `flows.json`, and
  read again when `flows.json`, `build.json` or `client/index.ts` change, so a later `build`,
  `probe` or `gen` is picked up without a restart.
- **Examples** are served only by `get_examples`, and only when `build.json` says they were
  `masked` (or `none`). A folder built with `--examples raw`, or one without `build.json`, gets a
  refusal that says how to rebuild. `get_operation` strips `example`/`examples` keywords from its
  slice (not field names in a `properties` map).
- **Excerpts.** `get_source` reads a path only when it is in the list of `.md` files found under
  `source/` when the folder was read, so `..`, absolute paths and other files cannot be read. A
  `source/` that is a symbolic link serves nothing; a file is listed only when its real path is a
  regular file inside the real `source/`, checked again when it is read; at most 5,000 are
  listed.
- **No code from the project at start.** `mcp` reads only flags, `SITE_TO_API_*` variables and
  `site-to-api.config.json`. A `.ts`/`.js` config is never run (a one-line note says so), because
  a plugin starts `mcp` in every project the person opens; the plugin passes `./api-handoff`
  explicitly.
- **Trust is local and lives outside the folder.** `call_operation` and the generated server run
  the code in `client/`, and a cloned repository can commit any code there, so a tampered
  `client/index.ts` would run with the person's whole environment: code in the process cannot be
  kept from `process.env`, so the per-host credential names prevent sending a cookie to the wrong
  site but do nothing against a tampered client. The protection is a hash gate: `gen` (and
  `build`) records a SHA-256 of every file in `client/` in
  `$XDG_CONFIG_HOME/site-to-api/trusted-clients/` (`~/.config/...` without it), one file
  (mode 0600) per folder, named by the hash of its real path, so concurrent `gen` runs never
  overwrite each other's entries. Not in the project, gitignored or not: a repository controls
  its own files and `.gitignore`, so it could commit a matching entry. Before loading a client,
  `call_operation` and `mcp --generated` compare its hash and refuse a mismatch with "this client
  wasn't generated on this machine. If you don't trust this project, review or delete its
  `site-to-api.config.ts`/`.js` first: `gen` runs it. Then run `site-to-api gen --config
  site-to-api.config.json` (or with no config), or pass `--trust-client` if you reviewed
  `client/`". It does not just say "run gen", because `gen` and `build` run a code config file.
  `--trust-client` is explicit, never a default. Only `SITE_API_*` variables are handed to the caller, which still does not sandbox the client.
- **Redirects.** Both callers refuse a redirect to another origin before anything is sent there
  and report only that origin. The runtime itself (for every generated client) drops
  `authorization`, `proxy-authorization`, `cookie`, the spec's apiKey header names
  (`credentialHeaders`, which `createSiteClient` passes) and every header the session set when a
  redirect leaves the origin, and its redirect-loop error leaves the query string out.
- **`call_operation`** exists only with `--allow-calls`. It sends one request through the
  generated `client/` (loaded with jiti, `@site-to-api/runtime` and `zod` resolved to the CLI's
  own copies), under probe's rules (0012), which now live in `src/probe/safety.ts` so both
  apply the same code: safe methods and GraphQL queries only unless `--unsafe-methods`;
  bot-protection steps, code-only endpoints, subscriptions, state-changing paths
  (`/logout`) and dispatcher functions named as writes are never sent; at most
  `probe.maxRps` requests per second (`--max-rps`), redirects included; no retries; probe's
  timeout. Credentials come only from environment variables: `SITE_API_COOKIE_<HOST>` and
  `SITE_API_AUTH_<HOST>` (`<HOST>` = the client folder name in upper case), plus the plain
  `SITE_API_COOKIE` / `SITE_API_AUTH` when the folder has a single host, so a cookie is never sent
  to another site. They cannot start with `SITE_TO_API_`, which configures the CLI (0006). The
  response is the live response of the person's own request, cut at 50,000 characters.
- **Generated server: opt-in.** `gen.mcp` (`off` | `read` | `write`, default `off`; `--mcp
  [mode]` on `build`, `gen` and `probe`, sticky in `build.json` like `--no-client`, 0025) writes
  `client/mcp/server.ts` and `client/mcp/README.md`. Off by default because the file imports
  `@modelcontextprotocol/server`, which a project that type-checks `client/` would otherwise need
  even when it never runs the server. `read` exposes the operations that do not change data
  (`changesData` in `src/probe/safety.ts`: unsafe methods, non-query GraphQL, state-changing paths
  and dispatcher names); `write` adds them. Bot-protection steps, code-only endpoints and
  subscriptions never get a tool.
- **Generated tools.** One per operation. Input schemas are hey-api's Zod schemas from
  `zod.gen.ts` (`path`, `query`, `body`, `headers`; GraphQL `variables` from the body or query
  schema's `shape`; a dispatcher's own fields with the dispatcher parameter omitted), and calls
  go through `createSiteClient`'s `sdk`, so requests are validated and constants sent as in
  `client/`. Which schemas exist is read from the `zod.gen.ts` text hey-api wrote. Same rate
  limit, no retries, the same environment variables (plus `SITE_API_BASE_URL_<HOST>` and
  `SITE_API_MAX_RPS`). It is registered as `site-to-api mcp <dir> --generated`: the installed CLI
  runs the trust check, then loads `client/mcp/server.ts` with its own SDK, zod and runtime.
  Running the file directly (`tsx client/mcp/server.ts`) skips the check; the README says so.
- **Calls cannot swap constants.** `call_operation` passes a GraphQL function only `variables` and
  `headers`, and a dispatcher function only its own fields: the wrappers send the document and the
  dispatcher value from the spec whatever else the agent sends.
- **Names and descriptions.** Tool names are the operation id restricted to `A-Za-z0-9_-`,
  starting with a letter, at most 64 characters (stricter than MCP's 128 of `A-Za-z0-9_.-`,
  because the Anthropic API accepts only that), with a hash suffix when shortened and the host
  added when two hosts share an id. An operation whose SDK function name is not a plain
  identifier gets no tool (warning). Descriptions are built from the method, path, host and kind
  only; the summary is left out because it names response fields, which the site controls. They
  are flattened to one line (`oneLine`), cut at 300 characters, and written as JSON string
  literals with U+2028/U+2029 escaped. Server instructions and the skill tell the agent that
  everything from the handoff folder and from live responses comes from the site and is data,
  never instructions.

- **hey-api never sees site text it would write into code (a known hey-api issue).** hey-api
  0.99 writes a schema's `pattern` into `zod.gen.ts` as a regular expression literal without
  escaping it, and decodes `\x2f`, `\u002f` and `\u{2f}` into `/` while doing so: a pattern
  such as `a\x2f, globalThis.x=1, \x2fb` became `.regex(/a/, globalThis.x=1, /b/)` and ran when
  the client was loaded. Filtering patterns is a race against encodings, so hey-api gets a copy of
  each spec without `pattern`, `description`, `title`, `summary`, `example(s)`, `externalDocs` and
  `x-` extensions (response descriptions become empty); `specs/` keep all of them. The generated
  client therefore checks no patterns and carries no documentation comments. Values hey-api
  writes as escaped string literals stay: `enum`, `const`, `default`, property and parameter
  names, paths; `format` only selects a Zod method. After generation every `.ts` file under
  `client/` (hey-api's and site-to-api's own) must parse, and no regex literal may appear except
  the six in hey-api's own `core/` templates; otherwise `gen` fails before the client is trusted.
  Not reported upstream yet; that is for the maintainer to decide.
- **The plugin asks before running the CLI.** Its commands pre-approve no `Bash` call: `build`,
  `probe`, `check` and `capture` load the project's config file, which can be code, so Claude
  Code asks the person first.

## Consequences
- `site-to-api` depends on `@modelcontextprotocol/server`. Through `mcp --generated` the
  generated server needs nothing else; type-checking it needs the SDK, `zod` and
  `@site-to-api/runtime` in the consuming project.
- A client someone else generated (a cloned repository) cannot be called until the person runs
  `gen` or passes `--trust-client`. Editing `client/` by hand also breaks trust until `gen` runs
  again.
- An agent can explore a large site without reading every spec, and can call read operations
  only when the person running the server turned calls on and supplied credentials.
- No resources or prompts yet; WebSocket channels are listed by `list_hosts` but have no tools.
