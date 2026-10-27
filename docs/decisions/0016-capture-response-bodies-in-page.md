# 0016 Read response bodies inside the page

Status: Accepted (2026-10-28)

## Context
Playwright's HAR leaves a response body empty (`size: -1`) when the page navigates before the
body was fetched. That is the normal shape of a login: POST the credentials, receive a token,
redirect. The first full end-to-end run lost the login token in one of three runs, so the bearer
token's origin could not be traced.

## Decision
The instrumentation reads a copy (`response.clone()`, XHR `responseText`) of every text fetch/XHR
response up to 2 MB in the page and sends it as a `response` event. `load` fills any HAR entry
without a body from the closest matching event (method, URL, status, time).

## Consequences
`events.jsonl` grows by the size of API responses; it is raw data and stays gitignored. Binary and
very large responses still depend on the HAR.
