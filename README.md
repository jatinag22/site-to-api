# site-to-api

**Browse a website once. Get everything a coding agent needs to build a wrapper for its internal
API.**

`site-to-api` records what a site's own pages do while you use it, then works out, without any
LLM, the endpoints, their parameters and schemas, the order requests happen in, which value feeds
which request, the browser code that computes values like encrypted passwords, and what a session
needs. It writes all of that into one folder: OpenAPI 3.1 specs, a flows document, readable maps
for an agent, excerpts of the site's own source code, and a typed TypeScript client with Zod
validation.

> Status: pre-release (`0.x`), not yet published to npm. See [Install](#install).

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
- **Honest about sessions.** Bot protection (Akamai, Cloudflare, PerimeterX, DataDome, Imperva,
  Kasada, captchas) is detected and recorded as "needs a real browser", never bypassed. `probe`
  measures what actually works with plain HTTP.

## Install

Requires Node 22.12+.

```sh
# from source until the first npm release
git clone https://github.com/jatinag22/site-to-api
cd site-to-api && pnpm install && pnpm run build
pnpm --filter site-to-api exec playwright install chromium   # only if you don't use your installed Chrome
alias site-to-api="node $PWD/packages/site-to-api/bin/site-to-api.mjs"
```

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

To try it without touching a real site, run the fixture shop used by the tests:
`pnpm --filter @site-to-api/e2e run fixture` (serves on `http://localhost:4173`).

## What you get

```
api-handoff/
  AGENT.md            start here: session needs per host, flows, computed values, gaps
  API_MAP.md          one row per operation: inputs and their origins, response, client symbols
  flows.json          source of truth for flows (schema: flows.schema.json)
  flows.md            the same, readable
  specs/<host>.yaml   OpenAPI 3.1 with x-site-to-api-* extensions
  source/             excerpts of the site's own code referenced above
  client/             typed client: hey-api SDK + Zod schemas, wired to @site-to-api/runtime
  probe.json          after `probe`: what each request needs (names only)
```

An excerpt of a generated `AGENT.md`, from the end-to-end test against the fixture shop:

```markdown
### localhost:4173

- Needs: a real browser is needed to establish the session; reuse its cookies for plain HTTP
  calls (confirmed by probe).
- Bot protection: Akamai (cookie _abck; cookie bm_sz; request body matches sensor_data). Do not
  try to reproduce it; let a real browser run it (`browserSession` in `@site-to-api/runtime`).
- Cookie `pm_session`: set by `postApiAuthLogin`.
- Cookie `pm_store`: set by a script in the page.

## Values computed in the browser

- `body./password` of `postApiAuthLogin`: `src/auth/crypto.ts:26 encryptPassword` using
  `crypto.subtle.encrypt` (name=RSA-OAEP); it uses `body./publicKey` from `getApiAuthKey`.
```

The full format is specified in [docs/output-format.md](docs/output-format.md).

## Commands

| Command | What it does |
|---|---|
| `init` | Writes `site-to-api.config.ts` and gitignores `.site-to-api/` |
| `capture [url]` | Opens a browser and records everything until you close it. `--script <file>` drives it from code instead; `--headless`; `--channel chrome\|msedge\|bundled`; `--user-data-dir` keeps logins |
| `build` | Analyses every capture and writes the handoff folder, including the client. `--include/--exclude <host>`, `--examples masked\|raw\|none`, `--no-client` |
| `probe` | Replays captured requests against the live site, rate limited, safe methods only unless `--unsafe-methods`; folds the results into the handoff folder |
| `gen` | Regenerates only `client/` |
| `config` | Prints the resolved config and where each value came from |

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
  probe: { maxRps: 1, unsafeMethods: false },
})
```

Precedence: CLI flags > `SITE_TO_API_*` environment variables (`__` nests:
`SITE_TO_API_REDACT__EXAMPLES=raw`) > config file > defaults. Unknown keys are errors.

## Using the generated client

```ts
import { browserSession, CookieJar } from '@site-to-api/runtime'
import { chromium } from 'playwright'
import { createSiteClient } from './api-handoff/client'

const jar = new CookieJar()
// For hosts that need a real browser: it loads the page, its cookies are reused for plain HTTP
// and refreshed when the site answers 401 or 403.
const session = browserSession({
  jar,
  bootstrap: async () => {
    const browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto('https://example.com', { waitUntil: 'networkidle' })
    const cookies = await page.context().cookies()
    await browser.close()
    return cookies
  },
})

const { sdk } = createSiteClient({ host: 'example.com', session, jar })
```

Hosts that work with plain HTTP use the default cookie session, or `tokenSession` for bearer
tokens. `client/README.md` says which one each host needs.

## How it compares

Based on each project's README as of October 2026.

| | site-to-api | reverse-api-engineer | Spectral | Integuru | mitmproxy2swagger |
|---|---|---|---|---|---|
| Analysis | deterministic | LLM | LLM | LLM | deterministic |
| Request dependencies | yes | not documented | auth flow | yes | no |
| Sourcemaps and code references | yes | not documented | not documented | not documented | no |
| Output | specs, flows, docs, TS client | client code, many languages | MCP tools, OpenAPI | Python code | OpenAPI |
| Secrets redacted by default | yes | not documented | not documented | not documented | not documented |

## Responsible use

Use it to integrate with services you are allowed to use, respect terms of use and rate limits,
and prefer an official API when one exists. The tool never defeats bot protection, captchas or
access controls, and never hides that the browser is automated. See
[docs/responsible-use.md](docs/responsible-use.md).

## Limitations

- Web Workers and Service Workers are not instrumented (their traffic is captured, without stacks).
- Redaction is pattern-based. Review the handoff folder before publishing it.
- HTML/text extraction from a single sample is low confidence; capture a second pass.
- GraphQL requests are treated as plain POST requests; there is no GraphQL-aware schema yet.
- Interactive capture (closing the window to finish) is covered by an abort test but not by an
  automated headful test.

## Contributing and docs

[CONTRIBUTING.md](CONTRIBUTING.md) · [Architecture](docs/architecture.md) ·
[Decision records](docs/decisions/README.md) · [Security policy](SECURITY.md)

## Licence

[MIT](LICENSE)
