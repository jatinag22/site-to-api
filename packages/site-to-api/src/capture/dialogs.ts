/**
 * JavaScript dialogs during a capture (decision 0059). Playwright dismisses every dialog of a page
 * nobody listens for (it accepts `beforeunload`), so without a listener a person capturing by
 * hand never sees an `alert()`, a `confirm()` always returns false and the request it guards is
 * never sent. A headed capture without a script therefore registers a listener that leaves each
 * dialog to Chrome's own, which the person answers. Scripts and headless runs keep Playwright's
 * behaviour: a script's own `dialog` listener decides, otherwise Playwright's default does, so
 * nothing waits for an answer that cannot come.
 *
 * Whoever answers, Chrome reports the dialog opening and closing on the page's DevTools protocol
 * (`Page.javascriptDialogOpening` / `Page.javascriptDialogClosed`); each pair becomes a `dialog`
 * capture event.
 */
import type { BrowserContext, CDPSession, Page } from 'playwright'
import type { DialogEvent } from '../model'

/** The dialog text kept: enough to say what was confirmed, not a page of terms. */
const MAX_MESSAGE = 2000

/** Who answers dialogs in a run. */
export type DialogAnswerer = 'person' | 'playwright'

/**
 * A person answers only in a headed run without a script: a headless browser shows nothing to
 * click, and a script either handles dialogs itself or expects Playwright's default.
 */
export function dialogAnswerer(scripted: boolean, headless: boolean): DialogAnswerer {
  return !scripted && !headless
    ? 'person'
    : 'playwright'
}

/**
 * Keeps dialogs open for the person: any `dialog` listener turns off Playwright's dismissal, and
 * this one does nothing, so Chrome's own dialog stays up until it is answered.
 */
export function leaveDialogsToPerson(context: BrowserContext): void {
  context.on('dialog', () => {})
}

/** What Chrome reports when a dialog opens (`Page.javascriptDialogOpening`), as used here. */
export interface DialogOpening {
  frameId: string
  type: string
  message: string
}

/**
 * What Chrome reports when a dialog closes (`Page.javascriptDialogClosed`), as used here.
 * `userInput`, the text typed into a prompt, is deliberately not part of it.
 */
export interface DialogClosing {
  frameId: string
  result: boolean
}

interface OpenDialog {
  ts: number
  pageUrl: string
  type: DialogEvent['type']
  message: string
}

function dialogType(type: string): DialogEvent['type'] | null {
  return type === 'alert' || type === 'confirm' || type === 'prompt' || type === 'beforeunload'
    ? type
    : null
}

/**
 * Pairs the opening and closing reports of one page's dialogs into `dialog` events. Chrome shows
 * at most one dialog per frame at a time, so the frame id is the key.
 */
export class DialogTracker {
  private readonly open = new Map<string, OpenDialog>()
  /** Set once the session ends: a dialog that closes as dismissed from then on closed with its page. */
  private ending = false

  constructor(private readonly write: (event: DialogEvent) => void) {}

  /** A dialog opened on a page then at `pageUrl`. Unknown dialog types are ignored. */
  opened(opening: DialogOpening, pageUrl: string, ts: number): void {
    const type = dialogType(opening.type)
    if (type === null)
      return
    this.open.set(opening.frameId, {
      ts,
      pageUrl,
      type,
      message: opening.message.slice(0, MAX_MESSAGE),
    })
  }

  /** A dialog was answered: `result` is true for OK or Leave. */
  closed(closing: DialogClosing, ts: number): void {
    const dialog = this.open.get(closing.frameId)
    if (dialog === undefined)
      return
    this.open.delete(closing.frameId)
    if (closing.result)
      this.emit(dialog, 'accepted', ts)
    else if (this.ending)
      this.emit(dialog, 'unanswered', null)
    else
      this.emit(dialog, 'dismissed', ts)
  }

  /**
   * The session is ending and capture is about to close the pages. Chrome reports a dialog that
   * closes with its page as dismissed; from now on such a dialog is unanswered instead, including
   * one whose opening is reported only now (the reports can trail the script that saw it open).
   */
  endSession(): void {
    this.ending = true
    this.unanswered()
  }

  /** The page closed: dialogs still open were never answered. */
  unanswered(): void {
    const left = [
      ...this.open.values(),
    ]
    this.open.clear()
    for (const dialog of left)
      this.emit(dialog, 'unanswered', null)
  }

  private emit(dialog: OpenDialog, answer: DialogEvent['answer'], answeredTs: number | null): void {
    this.write({
      t: 'dialog',
      ts: dialog.ts,
      pageUrl: dialog.pageUrl,
      type: dialog.type,
      message: dialog.message,
      answer,
      answeredTs,
    })
  }
}

/**
 * The capture warning when a script or Playwright declined dialogs that guard a step, or null.
 * `declined` counts the `confirm`, `prompt` and `beforeunload` dialogs dismissed or left
 * unanswered, by type. Names only the types: dialog text can hold personal data.
 */
export function dialogWarning(answerer: DialogAnswerer, declined: ReadonlyMap<DialogEvent['type'], number>): string | null {
  if (answerer === 'person' || declined.size === 0)
    return null
  const kinds = [
    ...declined.entries(),
  ]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${n} ${type}`)
    .join(', ')
  return `Dismissed or left unanswered ${kinds} dialog(s), so the steps they guard did not run. Playwright dismisses every dialog a capture script does not handle, and every dialog of a headless capture; to go ahead, accept them in a capture script: page.on('dialog', dialog => dialog.accept()).`
}

/**
 * Records the dialogs of every page of a session. Each page gets its own DevTools session, so
 * Chrome reports its dialogs whoever answers them: the person, a script or Playwright.
 */
export class DialogRecorder {
  private readonly attached = new WeakSet<Page>()
  private readonly declined = new Map<DialogEvent['type'], number>()
  private readonly trackers = new Set<DialogTracker>()

  constructor(
    private readonly context: BrowserContext,
    private readonly write: (event: DialogEvent) => void,
  ) {}

  /** Starts listening on a page; resolves once Chrome reports its dialogs. A closed page is skipped. */
  async attach(page: Page): Promise<void> {
    if (this.attached.has(page))
      return
    this.attached.add(page)
    let session: CDPSession
    try {
      session = await this.context.newCDPSession(page)
    }
    catch {
      return
    }
    const tracker = new DialogTracker((event) => {
      if (event.type !== 'alert' && event.answer !== 'accepted')
        this.declined.set(event.type, (this.declined.get(event.type) ?? 0) + 1)
      this.write(event)
    })
    this.trackers.add(tracker)
    session.on('Page.javascriptDialogOpening', opening => tracker.opened(opening, page.url(), Date.now()))
    session.on('Page.javascriptDialogClosed', closing => tracker.closed(closing, Date.now()))
    page.on('close', () => {
      tracker.unanswered()
      this.trackers.delete(tracker)
    })
    await session.send('Page.enable').catch(() => {})
  }

  /** The session is ending: records every dialog still open as unanswered, before pages close. */
  endSession(): void {
    for (const tracker of this.trackers)
      tracker.endSession()
  }

  /** The capture warning about declined dialogs ({@link dialogWarning}), or null. */
  warning(answerer: DialogAnswerer): string | null {
    return dialogWarning(answerer, this.declined)
  }
}
