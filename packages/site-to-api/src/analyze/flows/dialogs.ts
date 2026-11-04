/**
 * Which requests a JavaScript dialog guarded (decision 0064). A page that asks `confirm()` or
 * `prompt()` before a request stops until the person answers, and sends the request only when
 * they accept; Chrome reports when the dialog closed (`answeredTs`, decision 0059). The first step
 * request the page sent right after that is the one the dialog guarded.
 */
import type { ActionEvent, CaptureEvent, DialogEvent, Exchange, FlowStep } from '../../model'

/** A dialog that guarded a step, as `flows.json` holds it, before its message is redacted. */
type GuardingDialog = NonNullable<FlowStep['dialogs']>[number]

/**
 * How long after the dialog closed the guarded request may start. The page sends it from the code
 * right after `confirm()` returns, usually within milliseconds; the same bound as a navigation
 * that follows a click.
 */
const DIALOG_FOLLOWS_MS = 2000

/**
 * How long before capture saw the dialog open the click or submit that opened it may be. Capture
 * learns of a dialog from Chrome's report, handled when Node gets to it; a capture script (or
 * Playwright's default handler) may accept the dialog first, so the page can resume and send its
 * request before capture recorded the dialog as open at all.
 */
const ACTION_OPENS_DIALOG_MS = 2000

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
 * The earliest time the request a dialog guarded can have started: the click or submit on the
 * dialog's page that opened it, recorded by the page itself on the clock its requests use, or
 * when capture saw the dialog open when no such action was recorded (a dialog a timer opened).
 * Capture's own times for the dialog are when it handled Chrome's reports, which on a busy
 * machine come after the page resumed and sent the request, so neither is a safe bound alone.
 */
function earliestStart(dialog: AcceptedDialog, actions: readonly ActionEvent[]): number {
  const opener = actions.findLast(action => action.ts <= dialog.ts
    && action.ts >= dialog.ts - ACTION_OPENS_DIALOG_MS
    && withoutHash(action.pageUrl) === withoutHash(dialog.pageUrl))
  return opener?.ts ?? dialog.ts
}

/**
 * The accepted `confirm`, `prompt` and `beforeunload` dialogs of one session, by the id of the
 * request each guarded: the earliest step request (`isStep`) of the dialog's page that started
 * after the action that opened the dialog ({@link earliestStart}) and at most
 * {@link DIALOG_FOLLOWS_MS} after capture saw it close. One dialog guards at most one request; a
 * request after two dialogs (a prompt, then a confirm) lists both in the order they closed. Pure
 * and deterministic.
 */
export function guardedRequests(events: readonly CaptureEvent[], exchanges: readonly Exchange[], isStep: (exchange: Exchange) => boolean): Map<string, GuardingDialog[]> {
  const dialogs = events
    .filter(accepted)
    .toSorted((a, b) => a.answeredTs - b.answeredTs || a.ts - b.ts || a.message.localeCompare(b.message))
  const candidates = exchanges
    .filter(isStep)
    .toSorted((a, b) => a.startedAt - b.startedAt || a.seq - b.seq || a.id.localeCompare(b.id))
  const actions = events
    .filter((event): event is ActionEvent => event.t === 'action' && (event.kind === 'click' || event.kind === 'submit'))
    .toSorted((a, b) => a.ts - b.ts)
  const guarded = new Map<string, GuardingDialog[]>()
  for (const dialog of dialogs) {
    const from = earliestStart(dialog, actions)
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
