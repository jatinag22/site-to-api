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
- The record can only make a page public. An origin seen served from a public address even once
  stays public for the rest of the capture, whatever later documents or DNS say.
- A non-public served address never makes a page local. Behind an HTTP proxy (a corporate proxy
  on `10.x`, or mitmproxy, Charles, Proxyman or a VPN client on `127.0.0.1`) `serverAddr()` is the
  proxy's address, so every origin would look privately served. Playwright does not pass
  `--no-proxy-server`, so Chromium follows the system proxy, and trusting that address would let a
  public `www.evil.com` fetch a "sourcemap" from `meta.evil.com` on `169.254.169.254`. Otherwise
  the page is local only by the 0019 name rules: a local name, a non-public IP literal, or a name
  whose every resolved address is non-public. Behind a proxy, DNS decides.
- IPv6 addresses that Playwright reports in brackets (`[2606:4700::1]`) are unwrapped before they
  are recorded.
- A script waits for the address reads of its page's origin that are still pending, so a fast
  script cannot be judged before its document's address is known.

## Consequences
A page cannot become local by losing its server address after being seen on a public one, nor
by being loaded through a proxy. A page on a public-looking name that is really served from a
private network, with no proxy in between, is treated as public: its sourcemaps on private hosts
are refused with a warning, the safe side. What
0019 accepted still holds: DNS rebinding between our check of a sourcemap target and Playwright's
fetch of it is not prevented, and in-scope frames can still send well-formed invented events. Two
smaller cases also remain accepted: an origin whose every document came from a service worker or
cache from the start, or only from private (possibly proxy) addresses, is judged by DNS alone, and the record
lives only for one capture session, so a new session starts without it.
