# 0061 A relative code-only route is listed on one site, never on every page host

Status: Accepted (2026-11-04). Refines 0033.

## Context
Decision 0033 put a relative route nobody called on the pages that loaded its script, and on
every host that served pages when the capture did not show which pages those were. A capture of
two portals of one organisation listed a code-only `POST` from one portal's script under both
hosts. The portal sends no `Referer` (`Referrer-Policy: no-referrer`) and the capture recorded no
open page for its script requests, so the script's pages were unknown and the route fell back to
both page hosts. Routes in inline scripts have no script request at all and fell back the same
way. A route listed under a host whose pages never run it is an endpoint that does not exist.

## Decision
A relative route belongs to the first of these that the capture shows:
1. the hosts of the pages that loaded its script: the open page recorded with the script request
   (or its `Referer`); else the page the same session last navigated to, among the hosts that
   served pages, before the script was requested;
2. the script's own host, when that host served pages (a site's own script, or an inline script,
   whose host is its page's);
3. the one host that served pages (or the one observed host, when no page was captured).

When none of these names a single site and several hosts could have run the script, the route
is not listed as an operation on any of them. One build warning (in `AGENT.md` and `GAPS.md`)
names such routes, with path tokens masked, and says to capture the page that uses the feature.
A route with an absolute URL keeps its own host.

## Consequences
A shared CDN script whose pages the capture cannot place produces a warning instead of one
operation per site. Rule 1's "last navigation" can pick the wrong page when two tabs of
different sites load the same script at once; the result is one wrongly placed operation, not
one per host.
