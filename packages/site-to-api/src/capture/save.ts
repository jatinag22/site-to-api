/**
 * Saving a capture session (decision 0037): stop signals, bounded waits, closing the browser so
 * Playwright writes the HAR, and a forced shutdown when that does not happen. Kept apart from
 * `session.ts` so the waiting and killing can be tested without a browser.
 */
import type { SessionMeta } from '../model'
import type { FinishedHar } from './har'
import { rename, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { failedNavigationsWarning } from '../load'
import { finishHar } from './har'

/** How long saving a session waits before it gives up and saves what exists. */
export interface CaptureTimeouts {
  /** For pending page work (navigation labels, binding attachment) and for scripts being saved. */
  settleMs: number
  /** For pages and then the browser context to close, which is when Playwright writes the HAR. */
  closeMs: number
}

export const DEFAULT_TIMEOUTS: CaptureTimeouts = {
  settleMs: 15_000,
  closeMs: 30_000,
}

/** How long a forced shutdown waits for the browser to go. */
const KILL_MS = 5_000

export type Incomplete = NonNullable<SessionMeta['incomplete']>

interface Stopper {
  /** Aborts on the first stop: `signal`, SIGINT or SIGTERM. Ends the run or cuts waits short. */
  signal: AbortSignal
  /** Aborts on a second stop: give up waiting for the browser now. */
  forced: AbortSignal
  dispose: () => void
}

/**
 * Stop signals for the whole session, from launch until it is saved. Keeping the handlers until
 * the end means Ctrl+C while the session is being saved cuts the waiting short instead of killing
 * the process before the HAR and meta.json exist; a second one gives up on the browser.
 */
export function createStopper(signal: AbortSignal | undefined): Stopper {
  const first = new AbortController()
  const second = new AbortController()
  const stop = (): void => {
    if (first.signal.aborted)
      second.abort()
    else
      first.abort()
  }
  if (signal?.aborted)
    stop()
  signal?.addEventListener('abort', stop, { once: true })
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return {
    signal: first.signal,
    forced: second.signal,
    dispose: () => {
      signal?.removeEventListener('abort', stop)
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    },
  }
}

type WaitResult = 'done' | 'timeout' | 'stopped'

/** Waits for `task` at most `ms`, or until `stop` aborts; never throws. */
export async function waitBounded(task: Promise<unknown>, ms: number, stop: AbortSignal | null): Promise<WaitResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = (): void => {}
  try {
    return await Promise.race([
      task.then(() => 'done' as const, () => 'done' as const),
      new Promise<WaitResult>((resolve) => {
        timer = setTimeout(resolve, ms, 'timeout')
      }),
      new Promise<WaitResult>((resolve) => {
        if (stop === null)
          return
        onAbort = () => resolve('stopped')
        if (stop.aborted)
          onAbort()
        stop.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  }
  finally {
    clearTimeout(timer)
    stop?.removeEventListener('abort', onAbort)
  }
}

/** Writes JSON through a temporary file and a rename, so a crash never leaves half a file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, file)
}

/** The parts of a browser context saving needs; a structural type so tests can fake it. */
export interface ClosableContext {
  pages: () => Array<{ close: (options?: { runBeforeUnload?: boolean }) => Promise<void> }>
  close: () => Promise<void>
}

export interface SaveInput {
  context: ClosableContext
  pending: ReadonlySet<Promise<void>>
  collector: { settle: () => Promise<void> }
  harPath: string
  timeouts: CaptureTimeouts
  stopper: Pick<Stopper, 'signal' | 'forced'>
  /** Script mode: a stop ended the script early, so the session is incomplete. */
  scripted: boolean
  /** Ends the browser process when it does not close; must not throw. */
  kill: () => Promise<void>
  /** Puts back request bodies the HAR could not hold (`RequestBodyRecorder.patch`). */
  restoreBodies?: (entries: unknown[]) => number
}

export interface SaveResult {
  entries: number
  /** The checked and compacted HAR, or null when there is none to read. */
  har: FinishedHar | null
  warnings: string[]
  incomplete: Incomplete | null
  /** False when the context did not close and the browser was killed instead. */
  closed: boolean
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`

async function settleAll(input: SaveInput, warnings: string[]): Promise<Incomplete | null> {
  let incomplete: Incomplete | null = null
  const settle = async (task: Promise<unknown>, what: string): Promise<void> => {
    // In interactive mode the first Ctrl+C is the normal end, so only the second cuts waits short.
    const result = await waitBounded(task, input.timeouts.settleMs, input.scripted
      ? input.stopper.signal
      : input.stopper.forced)
    if (result === 'timeout') {
      incomplete ??= { reason: 'timeout', error: `${what} did not finish within ${seconds(input.timeouts.settleMs)}` }
      warnings.push(`Stopped waiting for ${what} after ${seconds(input.timeouts.settleMs)}; a page kept a connection open or stopped responding. The session was saved without it.`)
    }
    else if (result === 'stopped') {
      warnings.push(`Stopped waiting for ${what}: the capture was interrupted.`)
    }
  }
  await settle(Promise.all(input.pending), 'the pages')
  await settle(input.collector.settle(), 'scripts being saved')
  return incomplete
}

interface ClosedBrowser {
  closed: boolean
  incomplete: Incomplete | null
  /**
   * The close rejected only because the browser was already gone (Playwright's "Target page,
   * context or browser has been closed"). Whether anything is missing is then decided by the HAR:
   * {@link saveSession} keeps the session complete when the HAR is there and valid.
   */
  alreadyGone: boolean
}

/** Playwright's rejection for a page, context or browser that had already closed. */
const ALREADY_CLOSED = /has been closed|browser has disconnected|target closed/i

/** The message of a rejection. */
function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

/** Closes pages, then the context; kills the browser when that times out or a second stop comes. */
async function closeBrowser(input: SaveInput, warnings: string[]): Promise<ClosedBrowser> {
  const { closeMs } = input.timeouts
  // waitBounded counts a rejected promise as finished, so each task records its own failure:
  // a close that rejected wrote no HAR, and must never read as one that finished.
  let pagesFailed = false
  let closeError: string | null = null
  // Pages first, without beforeunload: closing the context waits forever on a page whose main
  // thread never yields, and the HAR is only written once the context has closed. A page that
  // was already closed is not a failure.
  const closingPages = Promise.all(input.context.pages().map(page => page.close({ runBeforeUnload: false }))).then(() => {}, (error: unknown) => {
    if (!ALREADY_CLOSED.test(messageOf(error)))
      pagesFailed = true
  })
  const pages = await waitBounded(closingPages, closeMs, input.stopper.forced)
  const closing = pages === 'stopped'
    ? null
    : input.context.close().then(() => {}, (error: unknown) => {
        closeError = messageOf(error)
      })
  const closed = closing === null
    ? 'stopped'
    : await waitBounded(closing, closeMs, input.stopper.forced)
  if (closed === 'done' && closeError === null)
    return { closed: true, incomplete: null, alreadyGone: false }
  await waitBounded(input.kill(), KILL_MS, null)
  // Playwright writes the HAR when the context's close finishes, which ending the browser lets
  // happen: wait for it (bounded) so the HAR is checked as it ends up, not before it is written.
  // On Amazon the check ran first and reported "0 requests" for a 718-request HAR.
  const flushed = closing === null
    ? 'stopped'
    : await waitBounded(closing, closeMs, input.stopper.forced)
  // Every page had closed and Playwright then finished closing, so the HAR holds everything the
  // pages did: only the browser process lingered (YouTube kept it busy past the wait). The
  // session is complete; ending the browser is worth a note, not an incomplete mark.
  if (closed === 'timeout' && pages === 'done' && !pagesFailed && flushed === 'done' && closeError === null) {
    warnings.push(`The browser did not close within ${seconds(closeMs)} after its pages had closed, so it was ended; the HAR was written in full afterwards.`)
    return { closed: false, incomplete: null, alreadyGone: false }
  }
  if (closeError !== null) {
    // The browser had gone on its own (a site closed its last window, the process exited): the
    // HAR decides. A close that failed for any other reason may have written no HAR.
    const gone = ALREADY_CLOSED.test(closeError) && pages === 'done' && !pagesFailed
    if (!gone)
      warnings.push(`Closing the browser failed (${closeError}), so it was ended and the HAR may be missing or incomplete.`)
    return {
      closed: false,
      incomplete: { reason: 'error', error: `closing the browser failed: ${closeError}` },
      alreadyGone: gone,
    }
  }
  if (closed === 'stopped') {
    warnings.push('Stopped waiting for the browser: a second stop signal arrived, so the browser was ended and the HAR may be missing.')
    return {
      closed: false,
      incomplete: { reason: 'interrupted', error: 'a second stop signal ended the browser' },
      alreadyGone: false,
    }
  }
  warnings.push(`The browser did not close within ${seconds(closeMs)}, so it was ended and the HAR may be missing or incomplete.`)
  return {
    closed: false,
    incomplete: { reason: 'timeout', error: `the browser did not close within ${seconds(closeMs)}` },
    alreadyGone: false,
  }
}

/**
 * Waits (bounded) for page work and scripts being saved, closes the browser so Playwright writes
 * the HAR, and checks and compacts it (`finishHar`). Never throws: whatever happens, the caller writes meta.json.
 */
export async function saveSession(input: SaveInput): Promise<SaveResult> {
  const warnings: string[] = []
  const settled = await settleAll(input, warnings)
  const browser = await closeBrowser(input, warnings)
  // In interactive mode a stop is how the person ends the session; only a script is cut short.
  const interrupted: Incomplete | null = input.scripted && input.stopper.signal.aborted
    ? { reason: 'interrupted', error: null }
    : null
  let incomplete = browser.incomplete ?? settled ?? interrupted
  let har: FinishedHar
  try {
    har = await finishHar(input.harPath, undefined, input.restoreBodies)
  }
  catch (error) {
    const reason = error instanceof Error
      ? error.message
      : String(error)
    // After a forced end the browser may still be writing; say what is known, not more.
    warnings.push(browser.closed
      ? reason
      : `${input.harPath} was not readable when the session was saved, after the browser was ended (${reason}). If the file is complete afterwards, build reads it; otherwise capture again and end the session by closing the browser window or pressing Ctrl+C.`)
    return {
      entries: 0,
      har: null,
      warnings,
      incomplete: incomplete ?? { reason: 'timeout', error: reason },
      closed: browser.closed,
    }
  }
  // The browser was gone before capture closed it, and the HAR it left is there and valid: nothing
  // is missing. Only the close's own error is dropped; a timeout or interruption still counts.
  if (browser.alreadyGone && incomplete === browser.incomplete) {
    incomplete = settled ?? interrupted
    warnings.push('The browser had already closed when the capture closed it; the HAR was read in full.')
  }
  warnings.push(...har.warnings)
  if (har.entries === 0)
    warnings.push('The HAR has no requests. Did the page load?')
  const blocked = failedNavigationsWarning(har.navigations)
  if (blocked !== null)
    warnings.push(blocked)
  return {
    entries: har.entries,
    har,
    warnings,
    incomplete,
    closed: browser.closed,
  }
}
