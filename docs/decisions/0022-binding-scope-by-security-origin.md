# 0022 Judge instrumentation calls by the caller's security origin

Status: Accepted (2026-10-28). Refines 0019.

## Context
A second review showed that the URL-based frame check of 0019 could be bypassed: a third-party
iframe can navigate a sibling third-party frame to `about:blank` (its URL then looked like the
site's) or open an `about:blank` popup (every main frame was accepted), and send forged events
recorded with the site's origin. It also found IPv6 forms that hide private IPv4 addresses, and
that intranet pages could not load sourcemaps from a second internal host.

## Decision
- The binding is installed per page through CDP. Each call is judged by Chromium's security origin
  of the calling execution context, never by a URL. Calls from isolated worlds or unknown contexts
  are ignored.
- First page: its top frame is accepted; other frames only when same-origin or same registrable
  host as the top frame's security origin.
- Any other page (popup): every frame, including its top frame, must be in scope of the capture's
  site (the start URL's origin, or the first page's origin when there is none). A popup on another
  site (for example an identity provider's sign-in window) is therefore not instrumented; its
  network traffic is still in the HAR.
- `frameOrigin` is the security origin.
- Private-address checks also refuse `::/96`, `64:ff9b:1::/48` (whole local-use NAT64 block),
  and judge `::ffff:0:0/96` and `2002::/16` by their embedded IPv4.
- An intranet page may load sourcemaps from another private host of the same intranet name
  (`app.corp` and `static.corp`); IP literals and `*.localhost` never vouch for another host, and a
  public page never reaches a private one.

## Consequences
Same-site frames that Chromium runs out of process (rare: origin-keyed isolation) cannot report
events. Popups get the binding when Playwright reports them; early messages are queued in the page
and retried for 10 seconds.
