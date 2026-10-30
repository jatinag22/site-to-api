# 0054 Answers that vary by request; a browser that was already gone

Status: Accepted (2026-10-30). Refines 0044, 0050.

## Context
The real-site recheck after 0050 and 0052 found two wrong verdicts on YouTube.

- `check` exited 1 on `GET /sw.js_data`: the live body was "not JSON". The body starts with
  `)]}'`, which `load` strips before parsing but `check` did not. Some answers also change on
  every request by nature (a field present in one answer and missing in the next), which `check`
  reported as drift although the capture itself shows that variation.
- Capture marked the session incomplete because `context.close()` rejected with Playwright's
  "Target page, context or browser has been closed", although every page had closed and the HAR
  held all 583 requests (0050 had made every rejected close incomplete).

## Decision
- `check` reads a live body the way `load` does: an XSSI prefix (`)]}'`, `while(1);`) is
  dropped before parsing.
- A difference is `varies`, not `drift`, when the status is the captured one, at least two
  captured answers with that status exist, and they already differ from each other at every
  drifting path (presence, or the set of JSON types there). The paths are listed with a note;
  `varies` does not change the exit code. A path that cannot be followed (a map key written as
  its shape) never counts as varying.
- A close that rejects only because the browser was already gone (`has been closed`,
  `browser has disconnected`, `target closed`) no longer marks the session incomplete by
  itself: the HAR decides. When it is there and valid the session is complete, with a note;
  when it is missing or invalid the session stays incomplete. A page that had already closed is
  not a failed close. Any other close failure keeps 0050's behaviour.
- An `error` session is described as "stopped on an error" with "what came after the error is
  missing", not as having failed before the run.

## Consequences
- `check.json` has one more verdict value, `varies`; readers that list the verdicts need it.
  `CHECK_FORMAT_VERSION` stays 1: no field changed, and nothing in the tool reads the file back.
- A field that varies in the capture and also really changed (a type it never had) is still
  reported as `varies` when the capture shows several types there; the listed paths say where.
