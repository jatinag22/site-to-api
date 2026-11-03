# Testing

Three layers, each catching what the one before it cannot. Automated tests prove the code does what
we meant; real sites prove what we meant is what the web does. Most bugs found before the first
release came from the third layer, not the first two.

## 1. Unit tests

Vitest, `foo.ts` → `foo.test.ts` beside it. Small hand-built inputs (`test/helpers.ts`), one test
per rule, including the inputs a hostile site could send. Never touch the network except a local
server the test starts itself. Rules in `AGENTS.md` → Tests.

## 2. End-to-end on the fixture site

`e2e/pipeline.test.ts` runs capture → build → probe → gen → check against Pinewood Market
(`e2e/fixture-site`), a local shop built to exercise every feature: an encrypted login, CSRF, toy
bot protection, HTML tables, GraphQL, a dispatcher endpoint, Socket.IO and MessagePack channels.
A feature that changes output extends the fixture and the e2e assertions. Anything that drives a
real browser must pass **10 consecutive runs** before it is committed; timing bugs do not show up in
one run.

## 3. Real sites (manual, before a release and after big changes)

Automated tests never visit third-party sites. Before a release, and after any change to capture,
analysis or redaction, run the pipeline by hand on a spread of real production sites:

| Kind | Examples used | What it exercises |
|---|---|---|
| Server-rendered HTML | Hacker News, Wikipedia, Stack Overflow | HTML extraction, path templating |
| SPA with JSON APIs | GitHub (logged out), IKEA | flows, value tracing, schemas |
| GraphQL / persisted queries | Spotify, Airbnb | GraphQL operations |
| Bot protection | NSE India (Akamai), Nike (Akamai, Kasada), Amazon (AWS WAF), Stack Overflow (Cloudflare) | detection, redaction of vendor data, probe verdicts |
| WebSockets | Binance, livecoinwatch.com (Socket.IO), lichess.org | channels, framing protocols |
| Dispatcher endpoints | NSE `GetQuoteApi` | one operation per function |

Rules:

- **Real browser, out of the way:** `capture <url> --channel chrome --minimized --script <file>`.
  Headless browsers are blocked by bot protection (NSE loaded nothing headless and 142 operations
  minimized), so never judge a site from a headless run.
- **Logged out and read-only** unless an account you own is used: browse, search, open detail pages;
  never post, buy, vote or sign up. Human-like pacing, about 20 page views per session, two sessions
  per site.
- **Stop at any captcha or challenge** and record it. Never retry in a loop to get past a block or a
  rate limit, and never try to solve or bypass one (decision 0008).
- **Raw captures hold real cookies:** keep them outside the repo, delete them after analysis.

For each site, check and record:

1. Pages loaded (status, title), request and operation counts.
2. Bot protection detected, with evidence; no vendor values in `api-handoff/`.
3. **Leak grep:** every cookie and token value from the raw capture searched for in `api-handoff/`;
   any hit is a release blocker.
4. Probe verdicts match reality (spot-check one or two calls with plain HTTP).
5. `check` exit code and verdicts.
6. AGENT.md size (index under about 25 KB) and whether a coding agent could build a wrapper from
   AGENT.md plus `hosts/<host>.md` alone.
7. `build` twice gives byte-identical output.

After a change to capture, also check dialogs by hand once, on a local page whose button asks
`confirm()` before a request (like the lists page in `e2e/fixture-site/dialogs.ts`): capture it
headed without a script, click the button, check that Chrome shows the dialog and waits,
click OK, and check that `events.jsonl` has the `dialog` event as `accepted` and the HAR has the
`DELETE`. Repeat with Cancel (`dismissed`, no `DELETE`).

## Reviews

Every change that is more than a few lines gets one independent review before merge, by a reviewer
who did not write it and reads the diff, not the author's summary. Changes to redaction, capture
trust, decoders of site data or anything that runs code or sends credentials (MCP) get a
security-focused review. Findings are fixed with a test each, the same reviewer re-checks only the
new commits, then the change merges after CI. See `docs/agents/team-brief.md`.
