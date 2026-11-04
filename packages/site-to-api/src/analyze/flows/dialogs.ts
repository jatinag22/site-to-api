/**
 * Which requests a JavaScript dialog guarded (decision 0064). A page that asks `confirm()` or
 * `prompt()` before a request stops until the person answers, and sends the request only when
 * they accept; Chrome reports when the dialog closed (`answeredTs`, decision 0059). The first step
 * request the page sent right after that is the one the dialog guarded.
 */
import type { CaptureEvent, DialogEvent, Exchange, FlowStep } from '../../model'

/** A dialog that guarded a step, as `flows.json` holds it, before its message is redacted. */
type GuardingDialog = NonNullable<FlowStep['dialogs']>[number]

/**
 * How long after the dialog closed the guarded request may start. The page sends it from the code
 * right after `confirm()` returns, usually within milliseconds; the same bound as a navigation
 * that follows a click.
 */
const DIALOG_FOLLOWS_MS = 2000

/**
 * How much earlier than `answeredTs` the guarded request may start. `answeredTs` is when capture
 * received Chrome's report, a little after the page resumed and could already send the request.
 * Never earlier than the dialog opened: a page waiting on a dialog sends nothing.
 */
const DIALOG_REPORT_LAG_MS = 250

function withoutHash(url: string): string {
  return url.split('#')[0] ?? url
}

type AcceptedDialog = DialogEvent & { type: GuardingDialog['type'], answeredTs: number }

/** `alert()` asks nothing, and a dismissed or unanswered dialog let no guarded request through. */
function accepted(event: CaptureEvent): event is AcceptedDialog {
  return event.t === 'dialog' && event.type !== 'alert' && event.answer === 'accepted' && event.answeredTs !== null
}

/**
 * A request from another page cannot be the one this dialog held up. A document request (the
 * navigation a `beforeunload` let through) and a request with no known page are not ruled out.
 */
function samePage(exchange: Exchange, dialog: AcceptedDialog): boolean {
  return exchange.pageUrl === null
    || exchange.resourceType === 'document'
    || withoutHash(exchange.pageUrl) === withoutHash(dialog.pageUrl)
}

/**
 * The accepted `confirm`, `prompt` and `beforeunload` dialogs of one session, by the id of the
 * request each guarded: the earliest step request (`isStep`) of the dialog's page that started
 * between {@link DIALOG_REPORT_LAG_MS} before the dialog closed (but not before it opened) and
 * {@link DIALOG_FOLLOWS_MS} after. One dialog guards at most one request; a request after two
 * dialogs (a prompt, then a confirm) lists both in the order they closed. Pure and deterministic.
 */
export function guardedRequests(events: readonly CaptureEvent[], exchanges: readonly Exchange[], isStep: (exchange: Exchange) => boolean): Map<string, GuardingDialog[]> {
  const dialogs = events
    .filter(accepted)
    .toSorted((a, b) => a.answeredTs - b.answeredTs || a.ts - b.ts || a.message.localeCompare(b.message))
  const candidates = exchanges
    .filter(isStep)
    .toSorted((a, b) => a.startedAt - b.startedAt || a.seq - b.seq || a.id.localeCompare(b.id))
  const guarded = new Map<string, GuardingDialog[]>()
  for (const dialog of dialogs) {
    const from = Math.max(dialog.ts, dialog.answeredTs - DIALOG_REPORT_LAG_MS)
    const to = dialog.answeredTs + DIALOG_FOLLOWS_MS
    const request = candidates.find(exchange => exchange.startedAt >= from && exchange.startedAt <= to && samePage(exchange, dialog))
    if (!request)
      continue
    guarded.set(request.id, [
      ...guarded.get(request.id) ?? [],
      { type: dialog.type, message: dialog.message },
    ])
  }
  return guarded
}
