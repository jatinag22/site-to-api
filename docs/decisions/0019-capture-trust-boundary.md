# 0019 Treat the captured site as untrusted input

Status: Accepted (2026-10-28)

## Context
An independent security review showed that a hostile page could send unlimited or forged
instrumentation events through the exposed binding (including from third-party iframes), make the
capture machine fetch "sourcemaps" from localhost or private networks, and break out of comments or
Markdown in the generated output with crafted paths, media types and labels.

## Decision
- Instrumentation events: every field and array has a hard size limit enforced in Node (labels 200
  chars, URLs 8 KB, stacks 16 KB, bodies 2 MB, 16 items per list); a session stops recording after
  200,000 events or 256 MB and says so; events from frames of other sites are dropped (same origin,
  or same registrable host, counts as in scope); each event records its frame origin.
- Response copies skip event streams (`text/event-stream`, ndjson, `stream+json`, multipart) and are
  read in chunks, cancelled past 2 MB or 30 s, so the page's own reading is never changed.
- Sourcemaps are fetched from public hosts, or from the script's own origin when the page itself is
  local (development servers). Loopback, private, link-local and `.local`/`.internal` targets are
  refused, redirects are followed manually and re-checked, and every refusal is a warning.
- Saved file names are safe on Windows (device names, trailing dots).
- Every site-controlled string written into generated code is escaped for its context (string
  literals via `JSON.stringify`, comments neutralised), and Markdown output escapes labels and code
  spans. AGENT.md states that quoted site text is untrusted data, not instructions.

## Consequences
In-scope frames can still send well-formed but invented events within the limits; the capture is
only as trustworthy as the site. DNS rebinding between our check and the fetch is not prevented.
