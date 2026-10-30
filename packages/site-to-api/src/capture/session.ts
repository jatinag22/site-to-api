import type { Buffer } from 'node:buffer'
/**
 * Runs one capture session: launches the browser, wires instrumentation, scripts and WebSocket
 * recording, waits for the person (or a capture script) to finish, then closes the context so
 * Playwright writes the HAR, and writes `meta.json`.
 */
import type { BrowserContext, Page, WebSocket } from 'playwright'
import type { ResolvedConfig } from '../config/schema'
import type { CaptureEvent, SessionMeta } from '../model'
import type { EventLimits } from './events'
import type { CaptureTimeouts, Incomplete } from './save'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createJiti } from 'jiti'
import { chromium } from 'playwright'
import pkg from '../../package.json' with { type: 'json' }
import { SiteToApiError } from '../errors'
import { RAW_FORMAT_VERSION, SessionMetaSchema } from '../model'
import { InstrumentBinding } from './binding'
import { RequestBodyRecorder } from './bodies'
import { EventWriter } from './events'
import { harOmissionNote } from './har'
import { instrumentSource, pageMessageToEvent } from './instrument'
import { defaultSessionId, sanitizeSessionId } from './paths'
import { launchWithSandbox } from './sandbox'
import { createStopper, DEFAULT_TIMEOUTS, saveSession, SessionEnd, waitBounded, writeJsonAtomic } from './save'
import { ScriptCollector } from './scripts'
import { EventStreamRecorder } from './streams'
import { launchArgs, minimizes, minimizeWindow } from './window'

/** Options for {@link runCapture}. */
export interface RunCaptureOptions {
  /** Page to open first. `null` opens `about:blank`. In script mode it is passed as `baseUrl`. */
  url: string | null
  /** Directory name under `rawDir`. Defaults to `<host or 'blank'>-<yyyyMMdd-HHmmss>` (UTC). */
  sessionId?: string
  /** Base for relative `rawDir`, `capture.script` and `userDataDir` paths. */
  cwd: string
  /** Ends an interactive session (or aborts a script) and saves what was captured. */
  signal?: AbortSignal
  /** Progress and instructions for the person running the capture. */
  log?: (message: string) => void
  /** Overrides the per-session event caps; tests use small ones. */
  eventLimits?: Partial<EventLimits>
  /** Overrides how long saving waits on the page and the browser; tests use short ones. */
  timeouts?: Partial<CaptureTimeouts>
}

/** What {@link runCapture} produced. */
export interface CaptureResult {
  /** Absolute path of `<rawDir>/<sessionId>`. */
  sessionDir: string
  meta: SessionMeta
  /** Non-fatal problems: missing sourcemaps, dropped events, scripts that could not be saved. */
  warnings: string[]
}

/** Arguments a capture script's default export receives. */
interface CaptureScriptContext {
  page: Page
  context: BrowserContext
  baseUrl: string | null
}
type CaptureScript = (context: CaptureScriptContext) => Promise<void> | void

const HAR_FILE = 'traffic.har'
const EVENTS_FILE = 'events.jsonl'
const META_FILE = 'meta.json'

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

/** Creates the raw directory with a `.gitignore` of `*`, so real cookies can never be committed. */
async function prepareRawDir(rawDir: string): Promise<void> {
  await mkdir(rawDir, { recursive: true })
  const ignore = path.join(rawDir, '.gitignore')
  if (!existsSync(ignore))
    await writeFile(ignore, '*\n')
}

async function loadCaptureScript(file: string): Promise<CaptureScript> {
  if (!existsSync(file))
    throw new SiteToApiError(`Capture script ${file} does not exist. Fix capture.script in your config or remove it for an interactive capture.`)
  const jiti = createJiti(import.meta.url, { moduleCache: false })
  let loaded: unknown
  try {
    loaded = await jiti.import(file, { default: true })
  }
  catch (error) {
    throw new SiteToApiError(`Could not load capture script ${file}: ${errorMessage(error)}`, { cause: error })
  }
  if (typeof loaded !== 'function')
    throw new SiteToApiError(`Capture script ${file} must export a default function: export default async ({ page, context, baseUrl }) => { ... }`)
  return async (scriptContext) => {
    await Reflect.apply(loaded, undefined, [scriptContext])
  }
}

type BrowserConfig = ResolvedConfig['capture']['browser']

/** Starts the browser; with `sandbox`, a failed start is retried once without it (decision 0047). */
async function launchContext(browser: BrowserConfig, cwd: string, harPath: string, warn: (message: string) => void): Promise<BrowserContext> {
  return await launchWithSandbox(sandbox => launchOnce(browser, cwd, harPath, sandbox), browser.sandbox, warn)
}

async function launchOnce(browser: BrowserConfig, cwd: string, harPath: string, sandbox: boolean): Promise<BrowserContext> {
  const optional = {
    ...(browser.channel === null
      ? {}
      : { channel: browser.channel }),
    ...(browser.locale === null
      ? {}
      : { locale: browser.locale }),
    ...(browser.timezone === null
      ? {}
      : { timezoneId: browser.timezone }),
    ...(browser.userAgent === null
      ? {}
      : { userAgent: browser.userAgent }),
  }
  try {
    // An empty profile path makes Playwright use a fresh temporary profile.
    return await chromium.launchPersistentContext(browser.userDataDir === null
      ? ''
      : path.resolve(cwd, browser.userDataDir), {
      ...optional,
      headless: browser.headless,
      // Playwright passes --no-sandbox unless this is set; Chrome then shows a warning bar too.
      chromiumSandbox: sandbox,
      args: launchArgs(browser),
      // SIGINT and SIGTERM end the session through createStopper, which closes the context and so
      // flushes the HAR; Playwright closing the browser itself would lose it.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      recordHar: { path: harPath, content: 'embed', mode: 'full' },
    })
  }
  catch (error) {
    const hint = browser.channel === null
      ? 'Run `npx playwright install chromium` to download the bundled browser.'
      : `Install ${browser.channel} or set capture.browser.channel to null to use Playwright's bundled Chromium.`
    throw new SiteToApiError(`Could not start the browser: ${errorMessage(error)}\n${hint}`, { cause: error })
  }
}

/**
 * Records one browsing session into `<rawDir>/<sessionId>/` (format in `src/model/capture.ts`).
 *
 * Interactive mode (no `capture.script`) opens `url` and waits until the person closes the last
 * tab or the browser, `signal` aborts, or SIGINT arrives. Script mode loads `capture.script` with
 * jiti and awaits its default export with `{ page, context, baseUrl }`; the script navigates
 * itself, starting from `baseUrl`. Either way the context is closed properly so the HAR is
 * flushed, and `meta.json` is written even when the script fails, the run is interrupted
 * (SIGINT, SIGTERM, `signal`) or a page never finishes: such sessions are marked `incomplete`
 * (decision 0037). Every wait while saving is bounded.
 */
export async function runCapture(config: ResolvedConfig, options: RunCaptureOptions): Promise<CaptureResult> {
  const log = options.log ?? ((): void => {})
  const { capture } = config
  const rawDir = path.resolve(options.cwd, config.rawDir)
  const sessionId = options.sessionId === undefined
    ? defaultSessionId(options.url, new Date())
    : sanitizeSessionId(options.sessionId)
  const sessionDir = path.join(rawDir, sessionId)

  await prepareRawDir(rawDir)
  if (existsSync(path.join(sessionDir, META_FILE)))
    throw new SiteToApiError(`Session ${sessionId} already exists in ${rawDir}. Pass a different session id or delete that folder.`)
  await mkdir(sessionDir, { recursive: true })

  const script = capture.script === null
    ? null
    : await loadCaptureScript(path.resolve(options.cwd, capture.script))
  if (options.signal?.aborted)
    throw new SiteToApiError('Capture was cancelled before the browser started.')

  const warnings: string[] = []
  const startedAt = new Date().toISOString()
  const harPath = path.join(sessionDir, HAR_FILE)
  const events = new EventWriter(path.join(sessionDir, EVENTS_FILE), options.eventLimits)
  const { browser } = capture
  const timeouts: CaptureTimeouts = {
    ...DEFAULT_TIMEOUTS,
    ...options.timeouts,
  }
  const stopper = createStopper(options.signal)

  let context: BrowserContext
  try {
    context = await launchContext(browser, options.cwd, harPath, (message) => {
      warnings.push(message)
      log(message)
    })
  }
  catch (error) {
    stopper.dispose()
    await events.close()
    throw error
  }

  const sessionEnd = trackSessionEnd(context, stopper.signal, script === null)
  const pending = new Set<Promise<void>>()
  const track = (task: Promise<void>): void => {
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }
  const collector = new ScriptCollector(sessionDir, context.request, { saveScripts: capture.saveScripts, sourcemaps: capture.sourcemaps })
  if (capture.saveScripts || capture.sourcemaps)
    context.on('response', response => collector.onResponse(response))
  // Bodies the HAR would garble (compressed or binary), kept as bytes for the HAR (decision 0050).
  const bodies = new RequestBodyRecorder()
  context.on('request', (request) => {
    try {
      bodies.record(request.method(), request.url(), request.postDataBuffer())
    }
    catch {
      // A request whose body cannot be read is recorded by the HAR as it is.
    }
  })
  const ignoredFrames = new Map<string, number>()
  const streams = capture.websockets
    ? new EventStreamRecorder(context, event => events.write(event))
    : null
  // Opened now, while the browser answers: the way to end it when closing does not work.
  const browserSession = await context.browser()?.newBrowserCDPSession().catch(() => null) ?? null
  const kill = async (): Promise<void> => {
    await browserSession?.send('Browser.close').catch(() => {})
  }
  let closed = false

  try {
    let userAgent = browser.userAgent ?? ''
    let incomplete: Incomplete | null = null
    try {
      const page = await prepare({
        context,
        streams,
        capture,
        options,
        events,
        ignoredFrames,
        warnings,
        track,
      })
      userAgent = browser.userAgent ?? await page.evaluate(() => navigator.userAgent)
      incomplete = script === null
        ? await runInteractive(context, page, options, stopper.signal, log)
        : await runScripted(script, scriptContext(context, sessionEnd), page, options, stopper.signal, log)
    }
    catch (error) {
      // Instrumentation or the first page failed before the run: save what exists anyway.
      incomplete = {
        reason: 'error',
        error: errorMessage(error),
      }
    }
    sessionEnd.end()
    logFailure(incomplete, log)
    const saved = await saveSession({
      context,
      pending,
      collector,
      harPath,
      timeouts,
      stopper,
      scripted: script !== null,
      kill,
      restoreBodies: entries => bodies.patch(entries),
      exitedEarly: () => sessionEnd.exitedEarly,
    })
    closed = true
    const finalIncomplete = incomplete ?? saved.incomplete
    warnings.push(...saved.warnings)
    const omitted = saved.har && harOmissionNote(saved.har, { websockets: capture.websockets, saveScripts: capture.saveScripts, eventsFile: EVENTS_FILE })
    if (omitted)
      log(omitted)
    const limits = [
      streams?.warning() ?? null,
      bodies.warning(),
    ].filter(warning => warning !== null)
    warnings.push(...collector.warnings, ...limits, ...await events.close(), ...ignoredFramesWarning(ignoredFrames))

    const meta = SessionMetaSchema.parse({
      formatVersion: RAW_FORMAT_VERSION,
      sessionId,
      toolVersion: pkg.version,
      startUrl: options.url,
      startedAt,
      completedAt: new Date().toISOString(),
      // `null` in the config means Playwright's bundled Chromium; say so instead of leaving it blank.
      browser: { channel: browser.channel ?? 'bundled', headless: browser.headless, userAgent },
      har: HAR_FILE,
      events: EVENTS_FILE,
      scripts: collector.scripts.toSorted((a, b) => a.url.localeCompare(b.url)),
      ...incompleteField(finalIncomplete),
    } satisfies SessionMeta)
    await writeJsonAtomic(path.join(sessionDir, META_FILE), meta)
    warnings.push(...incompleteWarning(sessionId, finalIncomplete))
    const requests = saved.har === null
      ? 'no readable HAR'
      : `${saved.entries} requests`
    log(`Saved session ${sessionId} to ${sessionDir} (${requests}, ${events.count} events, ${meta.scripts.length} scripts).`)
    return { sessionDir, meta, warnings }
  }
  finally {
    stopper.dispose()
    // Makes sure the browser never outlives a failed capture. Bounded, and skipped once saving
    // closed or ended it: a context that did not close in time will not close now either.
    if (!closed && await waitBounded(context.close(), timeouts.closeMs, null) !== 'done')
      await kill()
    await events.close()
  }
}

interface PrepareInput {
  context: BrowserContext
  /** Records server-sent events per page; null when `capture.websockets` is off. */
  streams: EventStreamRecorder | null
  capture: ResolvedConfig['capture']
  options: RunCaptureOptions
  events: EventWriter
  ignoredFrames: Map<string, number>
  warnings: string[]
  track: (task: Promise<void>) => void
}

/** Wires instrumentation, script collection and page watchers; returns the first page. */
async function prepare({ context, streams, capture, options, events, ignoredFrames, warnings, track }: PrepareInput): Promise<Page> {
  const { browser } = capture
  // Every document can call the binding; only the site's own are listened to (frames.ts).
  const binding = capture.instrument
    ? new InstrumentBinding(context, options.url, {
        accept: (text, origin) => {
          const result = pageMessageToEvent(text, origin)
          if ('event' in result)
            events.write(result.event)
          else
            events.reject(result.error)
        },
        ignore: (origin) => {
          ignoredFrames.set(origin, (ignoredFrames.get(origin) ?? 0) + 1)
        },
      })
    : null
  if (capture.instrument) {
    await context.addInitScript({
      content: instrumentSource(),
    })
  }

  let nextSocket = 0
  const watchPage = (page: Page): void => {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame())
        return
      const ts = Date.now()
      const url = frame.url()
      track(navigationLabel(page, url).then((label) => {
        events.write({
          t: 'action',
          kind: 'navigate',
          ts,
          pageUrl: url,
          label,
          selector: '',
          field: null,
        })
      }))
    })
    if (capture.websockets)
      page.on('websocket', ws => recordWebSocket(ws, page, nextSocket++, event => events.write(event)))
    if (streams !== null)
      track(streams.attach(page))
    // Popups open their own window, so every new page is minimized, not only the first.
    if (minimizes(browser)) {
      track(minimizeWindow(page).then((warning) => {
        if (warning !== null && !warnings.includes(warning))
          warnings.push(warning)
      }))
    }
  }
  context.pages().forEach(watchPage)
  context.on('page', watchPage)

  const page = context.pages()[0] ?? await context.newPage()
  // Before the first navigation, so a stream the first page opens at once is recorded.
  await streams?.attach(page)
  if (binding !== null) {
    // Attached before the first navigation, so the first page never misses an event.
    await binding.attach(page, true)
    context.on('page', p => track(binding.attach(p, false)))
    for (const other of context.pages())
      track(binding.attach(other, false))
  }
  return page
}

function logFailure(incomplete: Incomplete | null, log: (message: string) => void): void {
  if (incomplete === null || incomplete.reason === 'interrupted')
    return
  const what = incomplete.reason === 'script-failed'
    ? 'Capture script'
    : 'Capture'
  log(`${what} failed: ${incomplete.error ?? 'unknown error'}. Saving what was recorded.`)
}

function incompleteField(incomplete: Incomplete | null): Pick<SessionMeta, 'incomplete'> {
  return incomplete === null
    ? {}
    : { incomplete }
}

function incompleteWarning(sessionId: string, incomplete: Incomplete | null): string[] {
  if (incomplete === null)
    return []
  const detail = incomplete.error
    ? `: ${incomplete.error}`
    : ''
  return [`Session ${sessionId} is incomplete (${incomplete.reason}${detail}). What was recorded is saved and \`build\` will use it with a warning; capture again for full coverage.`]
}

function ignoredFramesWarning(ignored: Map<string, number>): string[] {
  if (ignored.size === 0)
    return []
  const total = [
    ...ignored.values(),
  ].reduce((sum, n) => sum + n, 0)
  const origins = [
    ...ignored.keys(),
  ].toSorted()
  const shown = origins.slice(0, 5).join(', ')
  const more = origins.length > 5
    ? ` and ${origins.length - 5} more`
    : ''
  return [`Ignored ${total} instrumentation event(s) from frames of other sites: ${shown}${more}.`]
}

async function navigationLabel(page: Page, url: string): Promise<string> {
  try {
    await page.waitForLoadState('load', { timeout: 10_000 })
    const title = (await page.title()).trim()
    if (title !== '')
      return title.slice(0, 80)
  }
  catch {
    // The page may have closed or navigated again; the URL path is still a usable label.
  }
  try {
    return new URL(url).pathname || url
  }
  catch {
    return url
  }
}

function recordWebSocket(ws: WebSocket, page: Page, socket: number, write: (event: CaptureEvent) => void): void {
  const base = (): { ts: number, pageUrl: string, url: string, socket: number } => ({
    ts: Date.now(),
    pageUrl: page.url(),
    url: ws.url(),
    socket,
  })
  const frameData = (payload: string | Buffer): string => typeof payload === 'string'
    ? payload
    : payload.toString('base64')
  write({
    ...base(),
    t: 'ws',
    direction: 'open',
    data: null,
  })
  ws.on('framesent', frame => write({
    ...base(),
    t: 'ws',
    direction: 'sent',
    data: frameData(frame.payload),
    binary: typeof frame.payload !== 'string',
  }))
  ws.on('framereceived', frame => write({
    ...base(),
    t: 'ws',
    direction: 'received',
    data: frameData(frame.payload),
    binary: typeof frame.payload !== 'string',
  }))
  ws.on('close', () => write({
    ...base(),
    t: 'ws',
    direction: 'close',
    data: null,
  }))
}

async function runInteractive(context: BrowserContext, page: Page, options: RunCaptureOptions, stop: AbortSignal, log: (message: string) => void): Promise<null> {
  let unsubscribe = (): void => {}
  const done = new Promise<void>((resolve) => {
    const finishIfEmpty = (): void => {
      if (context.pages().length === 0)
        resolve()
    }
    const watch = (p: Page): void => {
      p.on('close', finishIfEmpty)
    }
    context.pages().forEach(watch)
    context.on('page', watch)
    context.on('close', () => resolve())
    const onStop = (): void => resolve()
    if (stop.aborted)
      onStop()
    stop.addEventListener('abort', onStop, { once: true })
    unsubscribe = () => stop.removeEventListener('abort', onStop)
  })
  try {
    if (options.url !== null) {
      // A failed first load (typo, offline) should not end the session: the person can retry.
      await page.goto(options.url, { waitUntil: 'commit' }).catch((error: unknown) => {
        log(`Could not open ${options.url}: ${errorMessage(error)}`)
      })
    }
    log('Browser open. Use the site the way a person would: log in, search, open the pages you want covered.')
    log('When you are done, close the browser window (or press Ctrl+C here). The capture is saved on exit.')
    await done
    // Ending an interactive session is the normal way to finish it, not an interruption.
    return null
  }
  finally {
    unsubscribe()
  }
}

/** Runs the capture script; a failure or interruption is returned, so the session is still saved. */
/**
 * Records whether the person or the script ended the session before the browser closed
 * (decision 0055). Playwright closes every page before the context also on a crash, so a last
 * page closing ends the session only in interactive mode, where the person closed it.
 */
function trackSessionEnd(context: BrowserContext, stop: AbortSignal, interactive: boolean): SessionEnd {
  const sessionEnd = new SessionEnd()
  context.on('close', () => sessionEnd.browserClosed())
  stop.addEventListener('abort', () => sessionEnd.end(), { once: true })
  if (interactive) {
    const watch = (page: Page): void => {
      page.on('close', () => {
        if (context.pages().length === 0)
          sessionEnd.end()
      })
    }
    context.pages().forEach(watch)
    context.on('page', watch)
  }
  return sessionEnd
}

/**
 * The context a capture script gets: the same one, except that its `close()` first records that
 * the script ended the session, so a script that closes the browser is not taken for a crash.
 */
function scriptContext(context: BrowserContext, sessionEnd: SessionEnd): BrowserContext {
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === 'close') {
        return async (...args: Parameters<BrowserContext['close']>): Promise<void> => {
          sessionEnd.end()
          await target.close(...args)
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function'
        ? value.bind(target)
        : value
    },
  })
}

async function runScripted(script: CaptureScript, context: BrowserContext, page: Page, options: RunCaptureOptions, stop: AbortSignal, log: (message: string) => void): Promise<Incomplete | null> {
  log('Running capture script.')
  if (stop.aborted)
    return { reason: 'interrupted', error: null }
  let onStop = (): void => {}
  const stopped = new Promise<'stopped'>((resolve) => {
    onStop = () => resolve('stopped')
    stop.addEventListener('abort', onStop, { once: true })
  })
  try {
    const result = await Promise.race([
      Promise.resolve(script({ page, context, baseUrl: options.url })).then(() => 'done' as const),
      stopped,
    ])
    return result === 'stopped'
      ? { reason: 'interrupted', error: 'capture script cancelled' }
      : null
  }
  catch (error) {
    return {
      reason: 'script-failed',
      error: errorMessage(error),
    }
  }
  finally {
    stop.removeEventListener('abort', onStop)
  }
}
