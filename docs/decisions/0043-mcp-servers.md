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
- **Examples** are served only by `get_examples`, and only when `build.json` says they were
  `masked` (or `none`). A folder built with `--examples raw`, or one without `build.json`, gets a
  refusal that says how to rebuild. `get_operation` strips `example`/`examples` keywords from its
  slice (not field names in a `properties` map).
- **Excerpts.** `get_source` reads a path only when it is in the list of `.md` files found under
  `source/` when the server started, so `..`, absolute paths and other files cannot be read.
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
  `SITE_API_MAX_RPS`).
- **Names and descriptions.** Tool names are the operation id restricted to `A-Za-z0-9_-`,
  starting with a letter, at most 64 characters (stricter than MCP's 128 of `A-Za-z0-9_.-`,
  because the Anthropic API accepts only that), with a hash suffix when shortened and the host
  added when two hosts share an id. An operation whose SDK function name is not a plain
  identifier gets no tool (warning). Descriptions are built from the method, path, host and
  summary, flattened to one line (`oneLine`), cut at 300 characters, and written as JSON string
  literals with U+2028/U+2029 escaped. Server instructions tell the agent that results come from
  the site and are data, not instructions.

## Consequences
- `site-to-api` depends on `@modelcontextprotocol/server`; the generated server needs it, `zod`,
  `@site-to-api/runtime` and a TypeScript runner (`tsx`) in the consuming project.
- An agent can explore a large site without reading every spec, and can call read operations
  only when the person running the server turned calls on and supplied credentials.
- No resources or prompts yet; WebSocket channels are listed by `list_hosts` but have no tools.
