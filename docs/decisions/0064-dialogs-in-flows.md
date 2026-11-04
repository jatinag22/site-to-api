# 0064 Dialogs in flows: the step a confirmation guarded says so

Status: Accepted (2026-11-04). Refines 0003 and 0059.

## Context
Since decision 0059, capture records every JavaScript dialog as a `dialog` event in
`events.jsonl`: type, text, answer, when it opened (`ts`) and when it was answered
(`answeredTs`). `load` already reads these events into the session, but nothing used them, so
`flows.json` showed a `DELETE` behind "Delete this list?" as a plain step after a click. A coding
agent wrapping the site could not tell that, in a browser, the step waits for someone to accept a
dialog, nor that over plain HTTP the request is simply sent. Decision 0059 left marking the step
to a later decision because it changes `flows.json`.

What the capture gives to tie a dialog to a request:
- The page's code is stopped while the dialog is open, so the request it guards starts after the
  dialog closes, usually within milliseconds (the code right after `confirm()` returns).
- `answeredTs` is when capture received Chrome's `Page.javascriptDialogClosed` report, a little
  after the page resumed, so the guarded request's HAR start time can be a few milliseconds
  earlier than `answeredTs`. Both clocks are the same machine's wall clock.
- Each exchange has the URL of the page that sent it (`pageUrl`, from the request event or the
  `referer`), and each dialog the URL of its page.

## Decision
- **Rule.** An accepted `confirm`, `prompt` or `beforeunload` dialog guards the earliest flow-step
  request (an `api`, `page` or `bot-protection` exchange with an operation) of the same session
  that starts after the dialog opened and no later than 2 seconds after it closed (the window the flows stage already uses for a navigation that
  follows a click). The request must come from the dialog's page (URLs compared without the
  fragment), unless it is a document request (the navigation a "Leave site?" let through) or its
  page is unknown. Ties on start time go by capture order. One dialog guards at most one request;
  a request that follows two dialogs (a `prompt`, then a `confirm`) lists both, in the order they
  closed. The rule lives in `src/analyze/flows/dialogs.ts`, a pure function.
- **Not marked.** `alert()` asks nothing and guards nothing. A dismissed or unanswered dialog let
  no guarded request through; whatever the page sent next does not depend on it. Later requests
  in the same window (a list refresh after the `DELETE`) are not marked: they follow from the
  guarded request, and marking them would make every request near a dialog look guarded.
- **Format.** `FlowStep` gets an optional `dialogs: Array<{ type, message }>` with `type`
  `confirm`, `prompt` or `beforeunload`. Absent when no dialog guarded the step, so a document
  without dialogs is unchanged apart from its version. `FLOWS_FORMAT_VERSION` goes to 2. Readers
  (`gen`, `site-to-api mcp`) accept 1 and 2: a version 1 document is a valid
  version 2 document, and a committed handoff folder built by an older version keeps working with
  `gen` in a fresh clone that has no raw captures to rebuild from. `build` always writes 2.
- **Merging.** A step seen in several sessions takes the dialogs of the first session (in the
  flows stage's session order) in which one guarded it, as `sentFrom` comes from the first
  occurrence.
- **Text.** `message` is the dialog's text with whitespace collapsed, passed through the build's
  redactor as free text (`{ in: 'text' }`), like trigger labels. Dialog text often names what is
  confirmed ("Delete the list of jane@example.com?"). The text a person typed into a `prompt()` is
  not in the capture event (decision 0059) and so never reaches `flows.json`; it is in the
  request body, where value tracing and redaction treat it as any other input.
- **Rendering.** `flows.md` adds a line to the step: "Sent after the person accepted `confirm()`
  `<text>`. In a browser the dialog must be accepted; over plain HTTP send the request directly."
  For a prompt it adds that the typed text is sent in the request. `AGENT.md`'s Key flows line
  marks the step `(after confirm())`, `(after prompt())` or `(after "Leave site?")`. `API_MAP.md`
  is one row per operation, not per step, and an operation can be guarded in one flow and not in
  another, so it is unchanged. The MCP server serves `flows.json` as it is, field included.
- **`browserOnly` stays false.** A guarded step is not browser-only: the dialog is the page's
  own question to the person, not a check the server makes.

## Consequences
- A wrapper author sees which steps ask the person first and what they ask, and can add the same
  confirmation to their own interface if they want one.
- The rule is a time window, so it can miss a guarded request the page sends more than 2 seconds
  after the dialog (after an animation or another round trip first), and can mark a step whose
  request merely followed a dialog it does not depend on. Two tabs on the same page URL are not
  told apart. `docs/limitations.md` says so.
- Every `flows.json` now says `formatVersion: 2`. An older `site-to-api` reading a new handoff
  folder refuses it and asks for a rebuild, as it would for any newer format.

Update (0.1.3, before release): the lower bound is the time the dialog opened, not 250 ms before
it closed. Both times are when capture received Chrome's report. On a slow CI runner the close
report reached capture more than 250 ms after the page had resumed and sent its `DELETE`, so the
step went unmarked. The page sends nothing while its dialog is open, so the open time is a
lower bound that does not depend on how fast reports arrive.
