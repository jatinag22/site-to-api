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
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createJiti } from 'jiti'
import { chromium } from 'playwright'
import pkg from '../../package.json' with { type: 'json' }
import { SiteToApiError } from '../errors'
import { RAW_FORMAT_VERSION, SessionMetaSchema } from '../model'
import { InstrumentBinding } from './binding'
import { EventWriter } from './events'
import { finishHar, harOmissionNote } from './har'
import { instrumentSource, pageMessageToEvent } from './instrument'
import { defaultSessionId, sanitizeSessionId } from './paths'
import { ScriptCollector } from './scripts'
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

/** Calls `stop` when `signal` aborts or the process gets SIGINT; the returned function unsubscribes. */
function onStop(signal: AbortSignal | undefined, stop: () => void): () => void {
  const handler = (): void => stop()
  signal?.addEventListener('abort', handler, { once: true })
  process.once('SIGINT', handler)
  return () => {
    signal?.removeEventListener('abort', handler)
    process.removeListener('SIGINT', handler)
  }
}

type BrowserConfig = ResolvedConfig['capture']['browser']

async function launchContext(browser: BrowserConfig, cwd: string, harPath: string): Promise<BrowserContext> {
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
      args: launchArgs(browser),
      // SIGINT ends the session through onStop, which closes the context and so flushes the HAR.
      handleSIGINT: false,
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
 * flushed, and the HAR is checked before returning.
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

  let context: BrowserContext
  try {
    context = await launchContext(browser, options.cwd, harPath)
  }
  catch (error) {
    await events.close()
    throw error
  }

  const pending = new Set<Promise<void>>()
  const track = (task: Promise<void>): void => {
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }
  const collector = new ScriptCollector(sessionDir, context.request, { saveScripts: capture.saveScripts, sourcemaps: capture.sourcemaps })
  const ignoredFrames = new Map<string, number>()

  try {
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
    if (capture.saveScripts || capture.sourcemaps)
      context.on('response', response => collector.onResponse(response))

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
    if (binding !== null) {
      // Attached before the first navigation, so the first page never misses an event.
      await binding.attach(page, true)
      context.on('page', p => track(binding.attach(p, false)))
      for (const other of context.pages())
        track(binding.attach(other, false))
    }
    const userAgent = browser.userAgent ?? await page.evaluate(() => navigator.userAgent)

    if (script === null)
      await runInteractive(context, page, options, log)
    else
      await runScripted(script, context, page, options, log)

    await Promise.all(pending)
    await collector.settle()
    await context.close()

    const har = await finishHar(harPath)
    const { entries } = har
    const omitted = harOmissionNote(har, { websockets: capture.websockets, saveScripts: capture.saveScripts, eventsFile: EVENTS_FILE })
    if (omitted !== null)
      log(omitted)
    warnings.push(...har.warnings)
    if (entries === 0)
      warnings.push('The HAR has no requests. Did the page load?')
    warnings.push(...collector.warnings, ...await events.close(), ...ignoredFramesWarning(ignoredFrames))

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
    } satisfies SessionMeta)
    await writeFile(path.join(sessionDir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
    log(`Saved session ${sessionId} to ${sessionDir} (${entries} requests, ${events.count} events, ${meta.scripts.length} scripts).`)
    return { sessionDir, meta, warnings }
  }
  finally {
    // Idempotent: makes sure the browser never outlives a failed capture.
    await context.close().catch(() => {})
    await events.close()
  }
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

async function runInteractive(context: BrowserContext, page: Page, options: RunCaptureOptions, log: (message: string) => void): Promise<void> {
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
    unsubscribe = onStop(options.signal, resolve)
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
  }
  finally {
    unsubscribe()
  }
}

async function runScripted(script: CaptureScript, context: BrowserContext, page: Page, options: RunCaptureOptions, log: (message: string) => void): Promise<void> {
  log('Running capture script.')
  let unsubscribe = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    unsubscribe = onStop(options.signal, () => reject(new SiteToApiError('Capture script was cancelled.')))
  })
  aborted.catch(() => {})
  try {
    await Promise.race([
      script({ page, context, baseUrl: options.url }),
      aborted,
    ])
  }
  catch (error) {
    if (error instanceof SiteToApiError)
      throw error
    throw new SiteToApiError(`Capture script failed: ${errorMessage(error)}`, { cause: error })
  }
  finally {
    unsubscribe()
  }
}
