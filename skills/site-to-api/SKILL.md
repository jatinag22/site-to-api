---
name: site-to-api
description: Turn a website's own requests into a typed API wrapper with the site-to-api CLI. Use when someone wants to integrate with, script or wrap a website that has no public API, reverse-engineer what a web page calls, or work with an `api-handoff/` folder (AGENT.md, API_MAP.md, specs/, flows.json, client/).
---

# site-to-api

`site-to-api` records a browsing session in a real browser and writes an `api-handoff/` folder:
OpenAPI specs, request flows, source excerpts and a typed client. Everything in it is computed
from the capture; you do the reasoning. Full docs: `README.md`, `docs/output-format.md`,
`docs/responsible-use.md` in the site-to-api repository.

## 1. Capture (the person browses, you wait)

```sh
site-to-api init                                   # once: config + gitignore for .site-to-api/
site-to-api capture https://example.com --channel chrome
```

- By hand, in a normal Chrome window: the person uses the site the way the wrapper will (log in,
  search, open the pages that matter), then closes the browser, which ends the capture. Do not
  drive their session yourself.
- Unattended, for public pages only: write a script and run it minimized, so it does not take
  over the screen: `site-to-api capture https://example.com --channel chrome --minimized --script capture.ts`
  (`export default async ({ page, baseUrl }) => {}`).
- Ask for a second pass over the same pages (`capture` again): two sessions separate constants
  from per-session values.
- Only sites the person may use, under their terms. If the site shows a captcha or a challenge,
  the person solves it in the browser; you never do.

## 2. Build and read

```sh
site-to-api build
```

Read `api-handoff/AGENT.md`, then `api-handoff/hosts/<host>.md` for the host you are wrapping:

1. `AGENT.md` is a short index: the hosts with what each one's session needs (plain HTTP, cookies,
   token, real browser), the key flows and the gaps.
2. `hosts/<host>.md` has that host's details: cookies and who sets them, bot protection, computed
   values, GraphQL and dispatcher operations, channels, gaps.
3. Then, as needed: `API_MAP.md` (one row per operation), `flows.md`, `specs/<host>.yaml` and the
   `source/` excerpts they point to.

With the MCP server (`site-to-api mcp`, or the Claude Code plugin) use the tools instead of reading
whole files: `list_hosts` → `search_operations` → `get_operation` (inputs and where each value
comes from, session needs, the client call) → `get_flow`, `get_examples`, `get_source`.

## 3. Probe (optional, live, polite)

```sh
site-to-api probe
```

It replays captured requests to learn which cookies and headers plain HTTP really needs, then
rebuilds the folder. Defaults are the safe ones: GET/HEAD/OPTIONS and GraphQL queries, 1 request
per second. Add `--unsafe-methods` only when the person explicitly agrees that data on the site
may change.

## 4. Write the wrapper

- Use the generated client, not hand-written `fetch`: `createSiteClient({ host })` from
  `api-handoff/client/index.js`, then `sdk.<operation>(...)` with the options `get_operation` or
  `API_MAP.md` show. `client/README.md` says what each host's session needs and how to pass auth.
- An input "from" an earlier response: call that operation first and pass its output. "Computed
  by the page's code": port the function in the `source/` excerpt. "Set by the browser" (bot
  protection): get those cookies from a real browser with `browserSession`; never compute them.
- To try calls from an agent: `site-to-api mcp --allow-calls` (reads only; credentials from
  `SITE_API_COOKIE` / `SITE_API_AUTH`), or `site-to-api gen --mcp` for a per-site MCP server in
  `client/mcp/`.
- `site-to-api check` replays safe requests and reports API drift against the specs (exit code
  1 on drift); run it before trusting an old handoff folder.

## Rules

- Never bypass bot protection: no stealth plugins, no solving or replaying challenges, no faking
  sensor payloads. Browser-only steps stay in a real browser.
- Never commit `.site-to-api/` (raw captures: real cookies, tokens, personal data). Commit only
  the handoff folder, after reading it.
- Keep examples masked (the default). `--examples raw` copies captured values into the handoff
  folder; do not use it for anything that will be shared or committed.
- Credentials come from environment variables the person sets, never from the raw capture.
- Respect rate limits; do not raise `--max-rps` past what the person asks for.
