# 0040 Page locality from the addresses the browser used

Status: Accepted (2026-10-29). Refines 0019.

## Context
Decision 0019 lets a page on a non-public host (a development server, an intranet app) fetch
sourcemaps from its own non-public origin or site, and refuses every non-public target for a
public page. Whether the page is local was decided from Playwright's `serverAddr()` of the page
document, and, when no address was recorded, from a fresh DNS lookup of the page host.

A security review found the gap in that fallback: a document served by a service worker (or from
cache) has no server address. If the page's host name then resolved only to private addresses, as
after a DNS change during the capture, the fresh lookup made a page the browser had loaded from
the public internet count as local, and its scripts' sourcemaps could then reach private hosts of
the same site.

## Decision
- Capture keeps, for each page origin and for the whole session, the last address the browser
  connected to for one of its documents, and whether any of those addresses was public
  (`ServedAddresses` in `src/capture/network.ts`).
- A page is judged by that record before any DNS lookup: an origin seen served from a public
  address even once stays public for the rest of the capture, whatever later documents or DNS
  say; an origin only ever served from non-public addresses is local.
- Only an origin with no recorded address at all falls back to the 0019 rules (local names, IP
  literals, then a lookup where every address must be non-public).
- A script waits for the address reads of its page's origin that are still pending, so a fast
  script cannot be judged before its document's address is known.

## Consequences
A page cannot become local by losing its server address after being seen on a public one. What
0019 accepted still holds: DNS rebinding between our check of a sourcemap target and Playwright's
fetch of it is not prevented, and in-scope frames can still send well-formed invented events. Two
smaller cases also remain accepted: an origin whose every document came from a service worker or
cache from the start has no recorded address and still uses the DNS fallback, and the record
lives only for one capture session, so a new session starts without it.
