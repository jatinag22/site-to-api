# 0059 JavaScript dialogs in capture

Status: Accepted (2026-11-04). Refines 0019, 0037.

## Context

Capture registered no Playwright `dialog` listener, and Playwright dismisses every dialog nobody
listens for (it accepts `beforeunload`). During a capture by hand the person never saw an
`alert()`, every `confirm()` returned false and `prompt()` returned null. A step such as "Delete
this list? OK / Cancel" was silently cancelled, so the `DELETE` it guards was never sent and never
captured, and nothing said why.

Checked with Playwright 1.64.1 and Chrome 156 against a local page (scratch scripts, not committed):

- With no listener, `confirm()` returned false at once, headed and headless.
- With a listener that never calls `accept()` or `dismiss()`, the page waits: the guarded request
  is not sent and Playwright's `click()` does not return while the dialog is open. Chrome's
  `Page.javascriptDialogOpening` reports `hasBrowserHandler: true` headed (Chrome shows its own
  dialog) and `false` headless (nothing is shown; only the protocol can answer).
- Answering from outside Playwright (`Page.handleJavaScriptDialog` on a second DevTools session,
  the stand-in for a person's click) let the page continue: the `DELETE` was sent, later
  `page.title()` calls worked, and Playwright's own `Dialog` then failed with "No dialog is
  showing", which nothing calls. The machine the check ran on allowed no screen recording or
  synthetic key presses, so the person's click on Chrome's dialog itself was not automated; the
  native dialog is Chrome's documented behaviour when `hasBrowserHandler` is true, and the manual
  check in `docs/testing.md` covers it.
- Chrome reports `Page.javascriptDialogClosed` (`result`, `userInput`) however a dialog ends: by
  Playwright, by another session, and when its page closes (as `result: false`).
- Closing a page with a dialog open (`runBeforeUnload: false`, decision 0037) takes milliseconds.

## Decision

- **Who answers.** A headed capture without a script registers a context `dialog` listener that
  does nothing, so Playwright leaves every dialog to Chrome's own and the person answers it. A
  capture script, or a headless capture, registers nothing: a script's own `page.on('dialog')`
  decides as in plain Playwright, and otherwise Playwright's default applies (dismiss; accept
  `beforeunload`). Our listener would turn that default off, and a headless or unattended run would
  then wait on a dialog nobody can answer, so it is never added there. Scripts and capture never
  compete for the same dialog.
- **Recording.** Each page gets a DevTools session (like server-sent events, decision 0050) that
  pairs `javascriptDialogOpening` and `javascriptDialogClosed` by frame into one `dialog` capture
  event: `type` (`alert`, `confirm`, `prompt`, `beforeunload`), `message` cut to 2,000 characters,
  `answer` (`accepted`, `dismissed`, `unanswered`), `ts` (opened), `answeredTs` (null when
  unanswered) and `pageUrl`. It is recorded outside the page, so it has no `frameOrigin`, and the
  page cannot forge one: the instrumentation binding's schema (decision 0019) has no `dialog`.
  The event is written when the dialog closes.
- **Prompt text is never recorded.** Chrome's `userInput` is not read into the event; only whether
  the prompt was accepted. What the page then sends is in the HAR like any other request.
- **Unanswered.** When the session ends, dialogs still open are written as `unanswered` before the
  pages close, and a dismissal reported after that point is also `unanswered`: Chrome reports a
  dialog that closes with its page as dismissed, and its reports can trail the script that saw the
  dialog open.
- **Warning.** When a script or Playwright's default dismissed or left unanswered a `confirm`,
  `prompt` or `beforeunload`, capture warns with the counts by type (never the text, which can hold
  personal data) and says how a script accepts dialogs.
- **Format.** The `dialog` event is a new, additive member of the capture event union, as `sse` was
  (decision 0050). The raw format version stays 1, and AGENTS.md's "bump the version" is
  deliberately not followed here: a version 2 `meta.json` would make an older `site-to-api` skip
  every new session, with or without dialogs, while an older reader that meets a `dialog` line
  skips that line with a warning and reads the rest. A change that alters existing fields still
  bumps the version.

## Consequences

- Hand-driven captures now record the requests behind confirmations, and the person can leave a
  page with unsaved changes through Chrome's own "Leave site?" dialog instead of having it answered
  for them.
- `events.jsonl` says which steps needed a confirmation and how they were answered. `load` reads
  the events; analysis does not use them yet. Showing "needs confirmation" on a flow step in
  `flows.json` would change that format and is left for a later decision.
- A headed capture whose page opens a dialog while capture's own code reads the page title (for a
  navigation label) waits for the answer; that wait is bounded by the settle timeout when saving.
- A tab the person closes with a dialog still open records that dialog as `dismissed`, since
  Chrome reports it so before the page's close event.
