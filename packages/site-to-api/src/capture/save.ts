/**
 * Saving a capture session (decision 0037): stop signals, bounded waits, closing the browser so
 * Playwright writes the HAR, and a forced shutdown when that does not happen. Kept apart from
 * `session.ts` so the waiting and killing can be tested without a browser.
 */
import type { SessionMeta } from '../model'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { z } from 'zod'
import { failedNavigationsWarning, harNavigations } from '../load'

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

const HarSchema = z.object({
  log: z.object({
    entries: z.array(z.unknown()),
  }),
})

/** The HAR's entries, or why there are none (missing, empty or invalid). */
async function readHar(file: string): Promise<unknown[] | string> {
  let size = 0
  try {
    size = (await stat(file)).size
  }
  catch {
    return `The browser closed without writing ${file}. Capture again and end the session by closing the browser window or pressing Ctrl+C, not by killing the process.`
  }
  if (size === 0)
    return `${file} is empty. Capture again and end the session by closing the browser window or pressing Ctrl+C.`
  let data: unknown
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
  }
  catch {
    return `${file} is not a valid HAR file. Capture again.`
  }
  const parsed = HarSchema.safeParse(data)
  return parsed.success
    ? parsed.data.log.entries
    : `${file} is not a valid HAR file. Capture again.`
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
}

export interface SaveResult {
  entries: number
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

/** Closes pages, then the context; kills the browser when that times out or a second stop comes. */
async function closeBrowser(input: SaveInput, warnings: string[]): Promise<{ closed: boolean, incomplete: Incomplete | null }> {
  const { closeMs } = input.timeouts
  // Pages first, without beforeunload: closing the context waits forever on a page whose main
  // thread never yields, and the HAR is only written once the context has closed.
  const pages = await waitBounded(Promise.all(input.context.pages().map(page => page.close({ runBeforeUnload: false }))), closeMs, input.stopper.forced)
  const closed = pages === 'stopped'
    ? 'stopped'
    : await waitBounded(input.context.close(), closeMs, input.stopper.forced)
  if (closed === 'done')
    return { closed: true, incomplete: null }
  await waitBounded(input.kill(), KILL_MS, null)
  if (closed === 'stopped') {
    warnings.push('Stopped waiting for the browser: a second stop signal arrived, so the browser was ended and the HAR may be missing.')
    return {
      closed: false,
      incomplete: { reason: 'interrupted', error: 'a second stop signal ended the browser' },
    }
  }
  warnings.push(`The browser did not close within ${seconds(closeMs)}, so it was ended and the HAR may be missing or incomplete.`)
  return {
    closed: false,
    incomplete: { reason: 'timeout', error: `the browser did not close within ${seconds(closeMs)}` },
  }
}

/**
 * Waits (bounded) for page work and scripts being saved, closes the browser so Playwright writes
 * the HAR, and reads it back. Never throws: whatever happens, the caller writes meta.json.
 */
export async function saveSession(input: SaveInput): Promise<SaveResult> {
  const warnings: string[] = []
  const settled = await settleAll(input, warnings)
  const browser = await closeBrowser(input, warnings)
  // In interactive mode a stop is how the person ends the session; only a script is cut short.
  const interrupted: Incomplete | null = input.scripted && input.stopper.signal.aborted
    ? { reason: 'interrupted', error: null }
    : null
  const incomplete = browser.incomplete ?? settled ?? interrupted
  const har = await readHar(input.harPath)
  if (typeof har === 'string') {
    warnings.push(har)
    return {
      entries: 0,
      warnings,
      incomplete: incomplete ?? { reason: 'timeout', error: har },
      closed: browser.closed,
    }
  }
  if (har.length === 0)
    warnings.push('The HAR has no requests. Did the page load?')
  const blocked = failedNavigationsWarning(harNavigations(har))
  if (blocked !== null)
    warnings.push(blocked)
  return {
    entries: har.length,
    warnings,
    incomplete,
    closed: browser.closed,
  }
}
