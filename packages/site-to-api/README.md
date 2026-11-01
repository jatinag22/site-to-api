# site-to-api

**Browse a website once. Get everything a coding agent needs to build a wrapper for its internal
API.**

`site-to-api` records what a site's own pages do while you use it, then works out the
endpoints, their parameters and schemas, the order requests happen in, which value feeds which
request, and what a session needs. No LLM runs inside it. It writes one handoff folder with:

- OpenAPI 3.1 specs, plus AsyncAPI for WebSocket and event-stream channels;
- a flows document;
- readable maps for an agent (`AGENT.md`, one file per host);
- excerpts of the site's own source code;
- a typed TypeScript client with Zod validation.

Raw captures stay in a gitignored folder. Everything in the handoff folder is redacted by default.

## Install

Requires Node 22.12 or later.

```sh
npm install -D site-to-api
npx playwright install chromium   # only for --channel bundled or headless scripted captures
```

With pnpm, which does not expose Playwright's command, add `playwright` at the version
`site-to-api` depends on before running `pnpm exec playwright install chromium`.

## Use

```sh
npx site-to-api init                      # writes site-to-api.config.ts
npx site-to-api capture https://example.com   # use the site, close the browser to finish
npx site-to-api build                     # writes api-handoff/: specs, flows, AGENT.md, client
npx site-to-api probe                     # optional: what plain HTTP needs, rate limited
```

Then point your coding agent at `api-handoff/AGENT.md`. The generated client needs
`@site-to-api/runtime` and `zod` in the project that uses it.

## Documentation

The repository holds the full documentation:
- [README](https://github.com/jatinag22/site-to-api#readme): walkthrough, configuration, known
  limits;
- [output format](https://github.com/jatinag22/site-to-api/blob/main/docs/output-format.md);
- [responsible use](https://github.com/jatinag22/site-to-api/blob/main/docs/responsible-use.md):
  build integrations only with sites you are allowed to use, and never against bot protection,
  rate limits or access controls.

MIT licence.
