# 0057 Importing a HAR file as a raw session

Status: Accepted (2026-11-01). Refines 0031, 0037.

## Context
Many people already have a HAR: exported from browser DevTools (Chrome, Edge, Firefox, Safari)
or from a proxy (Charles, mitmproxy). Asking them to capture again is a barrier, and some cannot
run a capture browser at all. A HAR holds the traffic, but none of what capture's
instrumentation records: no JavaScript stacks (except Chrome's `_initiator`), no crypto or
`btoa` calls, no typed input, no response read inside the page, and sourcemaps are never fetched.

## Decision
- `site-to-api import <file.har> [--session <id>] [--delete-source]` writes a raw session under
  `<rawDir>/<session>/` with the same files a capture writes (`meta.json`, `traffic.har`,
  `events.jsonl`, `scripts/`), so build, probe and gen read it unchanged.
- The HAR is untrusted input. The file must be at most 256 MB (above that Node's default heap runs out inside `JSON.parse` before a friendly error could be shown), valid JSON and a HAR (`log.entries`
  an array); each entry is checked with load's schema and an invalid one is dropped with one
  warning that counts them. The session id is sanitized, every path is joined with `safeJoin`,
  an existing session is never overwritten, and the raw folder gets its `.gitignore` of `*`.
  Only known fields of an entry are written (load's schema output, `pageref`, `_frameref` and an
  `_initiator` cut to 8 stack levels), so a deeply nested vendor field cannot crash the write.
  The session is written into a temporary folder that is renamed at the end and removed on any
  error, so a failed import never blocks the next one.
- Chrome's default export strips Cookie, Set-Cookie and Authorization. When no entry has any of
  them, import warns and says to use "Export HAR (with sensitive data)"; AGENT.md says the same.
  Only `http:` and `https:` script bodies are saved (`data:` and `file:` have no host).
  Imported content goes through the same redaction and leak check as a capture's.
- What the HAR can give becomes events: a navigation per `log.pages` entry (named by its title,
  or by the path when Firefox gives the URL as title), or per page load when there are no pages;
  a `request` event with the stack for each entry with Chrome's `_initiator.stack` (async parents
  followed, frames made 1-based); `ws` events from Chrome's `_webSocketMessages` (opcode 2 is a
  binary frame). Script bodies the HAR holds are saved under `scripts/` for source analysis;
  asset bodies then leave the HAR as for a capture.
- `meta.json` gains `source: 'capture' | 'har-import'` and `importedFrom` (the HAR's creator and
  browser). Both are optional and additive, so the raw format version stays 1.
- `AGENT.md` has an "Imported sessions" section when any session was imported: no computed
  values or typed inputs, call sites only if the HAR had stacks, source analysis only if it held
  scripts, no sourcemaps, cookies set by page scripts seen only in requests, WebSocket frames
  only from Chrome exports (Firefox and Safari HARs have no `_webSocketMessages`).
- The HAR holds the person's cookies and tokens: `import` warns to delete it, and
  `--delete-source` deletes it once the session is saved.

## Consequences
- An imported session documents the API but cannot explain values the page computed; a capture
  fills that in.
- Response bodies a tool left out of its export (Safari for some types, a proxy for binary) are
  missing, as they would be for a capture that lost them.
