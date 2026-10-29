# 0033 Capture always saves the session, with bounded waits

Status: Accepted (2026-10-29)

## Context
A capture script that threw left `traffic.har` and `events.jsonl` but no `meta.json`, so `build`
said "No capture sessions found" and the recording was lost. On an Amazon product page the
script returned and the process never exited: saving waited without a limit on page work and on
`context.close()`, and a page whose main thread never yields makes both wait forever. Ctrl+C in
that phase killed the process (the SIGINT handler was gone once the script returned), and SIGTERM
let Playwright close the browser under the capture, which then threw an uncaught "Target page,
context or browser has been closed". A capture where every page load failed
(`net::ERR_HTTP2_PROTOCOL_ERROR` on NSE) was reported as a normal session.

## Decision
- `meta.json` is always written once the browser has started. A session that did not end
  normally carries `incomplete: { reason, error }` with reason `script-failed`, `interrupted`
  (SIGINT, SIGTERM or abort) or `timeout`. `build` uses such a session with a warning; a folder
  with a HAR and no `meta.json` (from older versions) gets a warning that says how to proceed.
  The field is optional and additive, so `RAW_FORMAT_VERSION` stays 1 and older readers accept
  the file.
- SIGINT and SIGTERM are handled from launch until the session is saved; Playwright's own
  SIGINT, SIGTERM and SIGHUP handling is off. A signal ends the session, or cuts the waiting
  short while it is being saved.
- Every wait while saving is bounded: page work and scripts being saved (15 s each), then pages
  are closed without `beforeunload` and the context is closed (30 s each). A timeout saves what
  exists, marks the session `timeout` and says what it stopped waiting for.
- `capture` exits with status 1 when the session is incomplete.
- When half or more of the page loads failed with no response, `capture` warns and `build` puts
  the same sentence in AGENT.md's gaps (first among the warnings), with the browser's error: the site probably blocks
  automated browsers; capture with a visible browser (`--channel chrome`, without `--headless`),
  and if that fails too, use the site's official API (decision 0008).

## Consequences
A session cut short by a timeout may miss the last responses of the page that did not finish.
That is reported, and it beats losing the session. Tests reproduce the hang with a page that
never yields its main thread.
