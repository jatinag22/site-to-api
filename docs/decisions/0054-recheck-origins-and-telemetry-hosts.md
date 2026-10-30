# 0054 Recheck fixes: empty answers, typed input, path substrings, `sigh`, telemetry hosts

Status: Accepted (2026-10-30). Refines 0041, 0047, 0052 and 0053.

## Context
A real-site recheck of the matrix after #53 and #54 found five errors: probe listing every
header of a bare 204 as required; YouTube's typed search losing to a pattern over the suggestion
list, a pattern that embedded the search text; Next.js prefetch headers traced to a route path
in a response header; Google's `sigh` ad-click signature unmasked; and consent, analytics and
telemetry hosts ranked first or given huge host files.

## Decision
- **Empty answers.** An empty live answer carries the captured content when the capture was
  empty too (a 204, a beacon's empty 200): a bare request that works needs nothing.
- **Typed input.** A typed field beats a producer read out of a page or text document, as it
  already beat a substring. The HTML locator rejects any pattern whose text holds a value the
  person searched for (search parameter values, with `+` and percent-encoded forms), and pattern
  anchors holding numbers of three or more digits count as data.
- **Substrings.** A value contained in another counts as copied only when the contained part is
  not a path (starts with `/`) and has some entropy (a digit or an upper-case letter).
- **`sigh`.** A query parameter named `sigh` is a secret, like `sig` and `signature`.
- **Telemetry hosts.** A host whose name says consent, analytics or telemetry (Sourcepoint,
  OneTrust, Cookiebot, OTLP collectors, Sentry, the site's own analytics host), or whose every
  observed call reports (OTLP exports, beacons and pings, 204s, POSTs answered empty), ranks last
  under "Consent, analytics and telemetry hosts", unless it served a page the person browsed.
  Its host file lists ten operations and counts its gaps instead of listing them.

## Consequences
A first-party API that answers every call with 204 is ranked with telemetry; it still has its
spec and `API_MAP.md` rows. A pattern needed for a value that only appears next to a search term
is not written; the value keeps another origin or none.
