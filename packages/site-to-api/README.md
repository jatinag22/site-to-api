# site-to-api

**Record one browsing session of a website. Get the OpenAPI specs, request flows and typed client
a coding agent needs to build a wrapper for its internal API.**

For developers who need to integrate with a website that has no public API. Use it only on sites
you are allowed to use; it never bypasses bot protection, captchas or access controls.

`site-to-api` records what a site's own pages do while you use it (or reads a HAR you exported),
then works out the endpoints, their parameters and schemas, the order requests happen in, which
value feeds which request, and what a session needs. No LLM runs inside it. It writes one handoff
folder with:

- OpenAPI 3.1 specs, plus AsyncAPI 3.0 for WebSocket and event-stream channels;
- request flows with the origin of every input;
- readable maps for an agent (`AGENT.md`, one file per host);
- excerpts of the site's own source code;
- a typed TypeScript client with Zod validation, and optionally an MCP server.

Raw captures stay in a gitignored folder. Everything in the handoff folder is redacted by default.

## Install

Requires Node 22.12 or later.

```sh
npm install -D site-to-api              # the CLI
npm install site-to-api-runtime zod    # what the generated client imports
```

`capture` opens Google Chrome, or Playwright's bundled Chromium where Chrome is not installed;
download that once with `npx playwright install chromium`. With pnpm, which does not expose
Playwright's command, add `playwright` at the version `site-to-api` depends on before running
`pnpm exec playwright install chromium`.

## Use

```sh
npx site-to-api init                          # writes site-to-api.config.ts
npx site-to-api capture https://example.com   # use the site, close the browser to finish
npx site-to-api build                         # writes api-handoff/: specs, flows, AGENT.md, client
npx site-to-api probe                         # optional: what plain HTTP needs, rate limited
```

Already have a HAR? `npx site-to-api import session.har --delete-source`, then `build`.

Then point your coding agent at `api-handoff/AGENT.md`, or serve the folder to it over MCP with
`npx site-to-api mcp ./api-handoff`. `gen.clientDir` in the config puts the client in your app's
source tree.

## Documentation

The repository holds the full documentation:

- [README](https://github.com/jatinag22/site-to-api#readme): capture, HAR import, the client in an
  app, MCP, known limits;
- [using the client](https://github.com/jatinag22/site-to-api/blob/main/docs/using-the-client.md);
- [configuration](https://github.com/jatinag22/site-to-api/blob/main/docs/configuration.md);
- [output format](https://github.com/jatinag22/site-to-api/blob/main/docs/output-format.md);
- [changelog](https://github.com/jatinag22/site-to-api/blob/main/CHANGELOG.md);
- [responsible use](https://github.com/jatinag22/site-to-api/blob/main/docs/responsible-use.md):
  build integrations only with sites you are allowed to use, and never against bot protection,
  rate limits or access controls.

MIT licence.
