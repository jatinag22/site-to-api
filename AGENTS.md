# Agent guide

Rules for any agent (or person) working in this repository. Read this file, then
`docs/architecture.md`, then the decision records in `docs/decisions/` that touch your area.

## What this project is

`site-to-api` turns one recorded browsing session of **any website** into everything a coding agent
needs to build a wrapper around that site's internal API: OpenAPI 3.1 specs, request flows with
their dependencies, pointers into the site's own source code, and a typed client with Zod
validation. It is a general tool for anyone, not tied to one site or project.

Design principles (each backed by a decision record):

1. **Deterministic analysis.** No LLM runs inside the pipeline. Everything is computed from the
   capture. The coding agent that reads the output does the reasoning (0013).
2. **Secrets never reach committed output.** Raw captures stay in a gitignored folder; everything
   written to the handoff folder is redacted by default (0004).
3. **Work with a real browser, never against bot protection.** No stealth plugins, no
   reimplementing anti-bot scripts. Bot-protection steps are recorded as browser-only (0008).
4. **Plain HTTP in production where the site allows it.** The browser is for discovery; the
   generated client uses `fetch` plus a cookie jar, with an optional browser-backed session.

## Repository map

```
packages/site-to-api/   CLI + analysis engine (published as `site-to-api`)
  src/cli/              commander wiring only; no logic
  src/config/           config schema, loading, precedence
  src/model/            shared data contracts (capture format, Exchange, flows.json, Analysis)
  src/hosts/            which host names are one site (shared by capture and analysis)
  src/capture/          Playwright session, instrumentation, sourcemaps, scripts
  src/import/           a DevTools or proxy HAR file → a raw session (`site-to-api import`)
  src/load/             raw session → Exchange[]
  src/analyze/          classify, operations, schema inference, correlate, flows, source, html, redact
  src/emit/             OpenAPI, flows.json/md, API_MAP.md, AGENT.md, excerpts
  src/probe/            live replay checks; the send rules the MCP servers share (safety.ts)
  src/check/            drift detection: probe's replay compared with the response schemas
  src/gen/              typed client generation (hey-api), extraction parsers, client/mcp/
  src/mcp/              `site-to-api mcp`: MCP server over the handoff folder (never raw captures)
packages/runtime/       `@site-to-api/runtime`: cookie jar, retry, sessions, extract(); no Node-only APIs
e2e/                    fixture website + full capture → build → probe → gen tests
docs/                   architecture, decision records, output format, responsible use
```

Each domain is a folder with an `index.ts` that exports its public functions. No loose files that
mix domains, no `export *` from internal modules except `src/model/index.ts`.

## Contracts

`src/model/` is the contract between stages. Change it only deliberately: update every stage that
uses it, add or update a decision record when the change affects the on-disk formats
(`events.jsonl`, `meta.json`, `flows.json`), and bump the format version constant.

## Coding standards

- TypeScript strict, ESM only, Node ≥ 22. TypeScript 6 (decision 0002).
- No `any`, no `as unknown as`, no `@ts-ignore`/`@ts-expect-error`, no non-null assertions to dodge
  a real possibility of `undefined`. Narrow with checks or Zod.
- Validate at boundaries with Zod: config, files read from disk, data from the browser. Inside the
  pipeline, trust the types.
- Errors: throw `SiteToApiError` (from `src/errors.ts`) with a message that says what to do next.
  Never swallow errors silently; if a failure is expected and harmless (a sourcemap 404), record it
  as a warning in the result.
- Pure functions for analysis stages: input data in, result out, no file system access. File I/O
  lives in `load/`, `emit/` and `capture/`.
- No `Math.random()` or `Date.now()` inside analysis stages: output must be deterministic for the
  same input (sort maps and arrays before emitting).
- Comments explain why, not what. JSDoc on exported functions and types.
- Prefer small dependencies; check maintenance and licence before adding one. Pin exact versions
  for anything pre-1.0 (hey-api).

## Tests

- Vitest. `foo.ts` → `foo.test.ts` next to it. Use `describe`/`it`.
- Every analysis function has unit tests with small hand-built inputs (build `Exchange`s with the
  helpers in `test/helpers.ts`).
- `e2e/` runs the real pipeline against the fixture site. Any feature that changes output must keep
  e2e green and extend it when the feature is user-visible.
- Never commit real captures, cookies or personal data, including in test fixtures.
- A test that drives a real browser (capture, e2e) must pass 10 consecutive runs before it is
  committed (`for i in $(seq 1 10); do pnpm exec vitest --run <file> -t "<name>" || break; done`).
  Timing bugs (background-tab timer throttling, load events, popups) do not show up in one run.
- Before a release and after changes to capture, analysis or redaction, run the manual real-site
  checks in `docs/testing.md`. Automated tests never visit third-party sites.

## Commands

```
pnpm install
pnpm run build        # all packages
pnpm run typecheck
pnpm run lint         # pnpm run lint:fix to autofix
pnpm run knip         # unused files, exports, dependencies
pnpm exec vitest --run                      # all tests
pnpm exec vitest --run --project site-to-api packages/site-to-api/src/analyze/
pnpm run ci           # everything CI runs
```

While working, run only the affected tests. A pre-push hook runs `pnpm run ci:push` (lint, build,
typecheck, knip and the tests affected by your changes against `origin/main`); do not bypass it with
`--no-verify`. GitHub CI runs the full `pnpm run ci` on every pull request, and nothing merges until
it passes. Fix root causes; do not add ignores.

## Git

- `main` is always releasable. Work on `feat/<area>`, `fix/<area>`, `docs/<topic>` branches.
- Conventional Commits with a body that explains why (enforced by the commit-msg hook), signed off
  (`git commit -s`, DCO).
- One logical change per commit. Merge to `main` through a pull request (squash merge) after CI
  passes. How pull requests are reviewed and merged, the squash commit format and Dependabot
  handling: [docs/maintaining.md](docs/maintaining.md).

## Responsible use

The tool is for building integrations with sites you are allowed to use. Do not add features whose
purpose is defeating bot protection, rate limits, captchas or access controls. Keep `probe` polite
(rate limited, safe methods by default). See `docs/responsible-use.md`.
