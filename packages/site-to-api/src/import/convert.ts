/**
 * Turns an imported HAR into what a captured session holds (decision 0057): the valid entries
 * for `traffic.har`, capture events rebuilt from what the HAR records (navigations from
 * `log.pages`, request stacks from Chrome's `_initiator`, WebSocket frames from Chrome's
 * `_webSocketMessages`) and the script bodies it carries. Pure: input data in, result out.
 */
import type { ActionEvent, CaptureEvent, RequestEvent, StackFrame, WebSocketEvent } from '../model'
import type { ImportHar } from './har-input'
import { Buffer } from 'node:buffer'
import { HarEntrySchema } from '../load'
import { HarPageSchema, InitiatorSchema, InitiatorStackSchema, WebSocketMessageSchema } from './har-input'

/** Script bodies larger than this are not saved: source analysis does not need a 10 MB bundle whole. */
const MAX_SCRIPT_BYTES = 10 * 1024 * 1024
/** Async parents of a stack that are followed, so a deep or cyclic chain stays bounded. */
const MAX_STACK_LEVELS = 8
/** Frames kept per request stack, as capture's instrumentation keeps. */
const MAX_STACK_FRAMES = 40
/** Request body preview length, as capture's instrumentation records it. */
const BODY_PREVIEW = 2048

/** What {@link convertHar} produces. */
export interface ConvertedHar {
  /** The valid entries with known fields only (their WebSocket frames are events instead). */
  entries: Array<Record<string, unknown>>
  /** Capture events in time order. */
  events: CaptureEvent[]
  /** Script bodies the HAR carries, for source analysis. */
  scripts: Array<{ url: string, content: string }>
  warnings: string[]
  /** The first top-level page load, or null. */
  startUrl: string | null
  startedAt: string | null
  completedAt: string | null
  userAgent: string
  /** Requests whose JavaScript stack the HAR recorded. */
  stacks: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function header(headers: ReadonlyArray<{ name: string, value: string }>, name: string): string | null {
  return headers.find(item => item.name.toLowerCase() === name)?.value ?? null
}

function isDocument(entry: Record<string, unknown>, mimeType: string | null | undefined): boolean {
  const type = entry._resourceType
  if (typeof type === 'string')
    return type.toLowerCase() === 'document'
  return (mimeType ?? '').toLowerCase().startsWith('text/html')
}

/** The frames of Chrome's `_initiator.stack`, async parents included, as 1-based stack frames. */
function stackOf(value: unknown): StackFrame[] {
  const frames: StackFrame[] = []
  let level: unknown = value
  for (let depth = 0; depth < MAX_STACK_LEVELS && level !== undefined && level !== null; depth++) {
    const parsed = InitiatorStackSchema.safeParse(level)
    if (!parsed.success)
      break
    for (const frame of parsed.data.callFrames) {
      if (frames.length >= MAX_STACK_FRAMES)
        return frames
      frames.push({
        url: frame.url,
        line: frame.lineNumber + 1,
        column: frame.columnNumber + 1,
        functionName: frame.functionName || null,
      })
    }
    level = parsed.data.parent
  }
  return frames
}

/** Chrome's `_webSocketMessages` as `ws` events: `open` when the entry started, then each frame. */
function socketEvents(entry: Record<string, unknown>, url: string, pageUrl: string, startedAt: number, socket: number): WebSocketEvent[] {
  const messages = Array.isArray(entry._webSocketMessages)
    ? entry._webSocketMessages
    : []
  const events: WebSocketEvent[] = [
    {
      t: 'ws',
      ts: startedAt,
      pageUrl,
      url,
      socket,
      direction: 'open',
      data: null,
    },
  ]
  for (const raw of messages) {
    const message = WebSocketMessageSchema.safeParse(raw)
    if (!message.success)
      continue
    events.push({
      t: 'ws',
      ts: Math.round(message.data.time * 1000),
      pageUrl,
      url,
      socket,
      direction: message.data.type === 'send'
        ? 'sent'
        : 'received',
      // Chrome writes a binary frame (opcode 2) as base64 already.
      data: message.data.data,
      binary: message.data.opcode === 2,
    })
  }
  return events
}

/** A `request` event for an entry Chrome recorded a script stack for; null without one. */
function requestEvent(entry: Record<string, unknown>, method: string, url: string, pageUrl: string, startedAt: number, body: string | null): RequestEvent | null {
  const initiator = InitiatorSchema.safeParse(entry._initiator)
  if (!initiator.success || initiator.data.type !== 'script')
    return null
  const stack = stackOf(initiator.data.stack)
  if (stack.length === 0)
    return null
  return {
    t: 'request',
    ts: startedAt,
    pageUrl,
    via: entry._resourceType === 'xhr'
      ? 'xhr'
      : 'fetch',
    method,
    url,
    bodyPreview: body === null
      ? null
      : body.slice(0, BODY_PREVIEW),
    stack,
  }
}

/** The text of a response body, base64 decoded when the HAR says so. */
function bodyText(content: { text?: string | null, encoding?: string | null } | null | undefined): string | null {
  const text = content?.text
  if (text === null || text === undefined || text === '')
    return null
  return content?.encoding === 'base64'
    ? Buffer.from(text, 'base64').toString('utf8')
    : text
}

function isScript(entry: Record<string, unknown>, mimeType: string | null | undefined): boolean {
  if (entry._resourceType === 'script')
    return true
  return /javascript|ecmascript/i.test(mimeType ?? '')
}

/**
 * The body of a script entry worth saving for source analysis, or null. A `data:` or `file:`
 * script has no host to file it under and is not the site's code.
 */
function scriptBody(raw: Record<string, unknown>, entry: ValidEntry['entry']): string | null {
  if (!/^https?:/i.test(entry.request.url) || !isScript(raw, entry.response.content?.mimeType))
    return null
  const content = bodyText(entry.response.content)
  return content !== null && Buffer.byteLength(content) <= MAX_SCRIPT_BYTES
    ? content
    : null
}

/** A navigation's label: the page title, or the path when the title is a URL (Firefox). */
function pageLabel(title: string | null | undefined, url: string): string {
  if (title && !/^[a-z]+:\/\//i.test(title))
    return title
  try {
    return new URL(url).pathname || url
  }
  catch {
    return url
  }
}

interface ValidEntry {
  raw: Record<string, unknown>
  entry: ReturnType<typeof HarEntrySchema.parse>
  startedAt: number
}

/** The first page load of each `pageref`, by time: the URL its navigation is named after. */
function pageUrls(entries: readonly ValidEntry[]): Map<string, string> {
  const urls = new Map<string, string>()
  for (const { raw, entry } of [...entries].sort((a, b) => a.startedAt - b.startedAt)) {
    const pageref = raw.pageref
    if (typeof pageref === 'string' && !urls.has(pageref) && isDocument(raw, entry.response.content?.mimeType))
      urls.set(pageref, entry.request.url)
  }
  return urls
}

/** Navigation actions: one per `log.pages` entry, or per page load when the HAR lists no pages. */
function navigations(har: ImportHar, entries: readonly ValidEntry[], urls: ReadonlyMap<string, string>): ActionEvent[] {
  const pages = (har.log.pages ?? []).flatMap((raw) => {
    const page = HarPageSchema.safeParse(raw)
    return page.success
      ? [page.data]
      : []
  })
  const action = (ts: number, url: string, label: string): ActionEvent => ({
    t: 'action',
    kind: 'navigate',
    ts,
    pageUrl: url,
    label,
    selector: '',
    field: null,
  })
  if (pages.length > 0) {
    return pages.flatMap((page) => {
      const url = urls.get(page.id)
      const ts = Date.parse(page.startedDateTime)
      return url === undefined || Number.isNaN(ts)
        ? []
        : [
            action(ts, url, pageLabel(page.title, url)),
          ]
    })
  }
  return entries
    .filter(({ raw, entry }) => isDocument(raw, entry.response.content?.mimeType))
    .map(({ entry, startedAt }) => action(startedAt, entry.request.url, pageLabel(null, entry.request.url)))
}

/**
 * Chrome's `_initiator` cut to what load and a reader need: its type and at most
 * {@link MAX_STACK_LEVELS} stack levels of {@link MAX_STACK_FRAMES} frames in all. An exporter's
 * (or an attacker's) chain of any depth must not reach `JSON.stringify`, which recurses.
 */
function boundedInitiator(value: unknown): Record<string, unknown> | null {
  const initiator = InitiatorSchema.safeParse(value)
  if (!initiator.success)
    return null
  const bounded: Record<string, unknown> = { type: initiator.data.type }
  let budget = MAX_STACK_FRAMES
  let level: unknown = initiator.data.stack
  let parentOf: Record<string, unknown> = bounded
  let key = 'stack'
  for (let depth = 0; depth < MAX_STACK_LEVELS && budget > 0 && level !== undefined && level !== null; depth++) {
    const parsed = InitiatorStackSchema.safeParse(level)
    if (!parsed.success)
      break
    const callFrames = parsed.data.callFrames.slice(0, budget)
    budget -= callFrames.length
    const copy: Record<string, unknown> = { callFrames }
    parentOf[key] = copy
    parentOf = copy
    key = 'parent'
    level = parsed.data.parent
  }
  return bounded
}

/**
 * The entry as stored: load's parsed fields (Zod drops every key it does not list), the vendor
 * fields load reads when they have the expected simple type, and a bounded `_initiator`.
 */
function knownFields(raw: Record<string, unknown>, entry: ValidEntry['entry']): Record<string, unknown> {
  const kept: Record<string, unknown> = { ...entry }
  for (const key of ['pageref', '_frameref']) {
    const value = raw[key]
    if (typeof value === 'string' || typeof value === 'number')
      kept[key] = value
  }
  const initiator = boundedInitiator(raw._initiator)
  if (initiator !== null)
    kept._initiator = initiator
  return kept
}

/**
 * True when some entry carries a cookie or an Authorization header. Chrome's default HAR export
 * strips Cookie, Set-Cookie and Authorization, which leaves a session that cannot show how the
 * site authenticates.
 */
function hasCredentials(entries: readonly ValidEntry[]): boolean {
  return entries.some(({ entry }) =>
    (entry.request.cookies?.length ?? 0) > 0
    || (entry.response.cookies?.length ?? 0) > 0
    || entry.request.headers.some(item => /^(?:cookie|authorization)$/i.test(item.name) && item.value !== '')
    || entry.response.headers.some(item => /^set-cookie$/i.test(item.name) && item.value !== ''))
}

/** Says how to export again when the HAR has no cookies or Authorization headers at all. */
const NO_CREDENTIALS_WARNING = 'No request in this HAR has a cookie or an Authorization header, so the session cannot show how the site signs you in. Browsers often leave them out: in Chrome, export with "Export HAR (with sensitive data)" (DevTools settings, Network, "Allow to generate HAR with sensitive data"); if the site needs no sign-in, ignore this.'

/** The entries that pass load's schema and have a date; one warning counts the rest. */
function validEntries(raws: readonly unknown[]): { valid: ValidEntry[], warnings: string[] } {
  const valid: ValidEntry[] = []
  let invalid = 0
  let firstProblem = ''
  for (const raw of raws) {
    const parsed = HarEntrySchema.safeParse(raw)
    const startedAt = parsed.success
      ? Date.parse(parsed.data.startedDateTime)
      : Number.NaN
    if (parsed.success && isRecord(raw) && !Number.isNaN(startedAt)) {
      valid.push({ raw, entry: parsed.data, startedAt })
      continue
    }
    invalid++
    firstProblem ||= parsed.success
      ? 'startedDateTime is not a date'
      : parsed.error.issues[0]?.message ?? 'not a HAR entry'
  }
  const plural = invalid === 1
    ? 'entry'
    : 'entries'
  return {
    valid,
    warnings: invalid > 0
      ? [`Skipped ${invalid} HAR ${plural} that are not valid HAR (first problem: ${firstProblem}).`]
      : [],
  }
}

/**
 * Converts a validated HAR. Entries that fail load's schema are dropped with one warning that
 * counts them; a WebSocket entry's frames become `ws` events; a script stack becomes a `request`
 * event; script bodies are returned for saving.
 */
export function convertHar(har: ImportHar): ConvertedHar {
  const { valid, warnings } = validEntries(har.log.entries)
  if (valid.length > 0 && !hasCredentials(valid))
    warnings.push(NO_CREDENTIALS_WARNING)

  const urls = pageUrls(valid)
  const events: CaptureEvent[] = [
    ...navigations(har, valid, urls),
  ]
  const scripts: Array<{ url: string, content: string }> = []
  const entries: Array<Record<string, unknown>> = []
  let socket = 0
  let stacks = 0
  for (const { raw, entry, startedAt } of valid) {
    const url = entry.request.url
    const pageref = raw.pageref
    const pageUrl = (typeof pageref === 'string'
      ? urls.get(pageref)
      : undefined) ?? header(entry.request.headers, 'referer') ?? url
    // Only known fields are kept: an exporter's (or an attacker's) other fields, however deep,
    // never reach traffic.har.
    entries.push(knownFields(raw, entry))
    if (/^wss?:/i.test(url) || Array.isArray(raw._webSocketMessages)) {
      events.push(...socketEvents(raw, url, pageUrl, startedAt, socket++))
      continue
    }
    const request = requestEvent(raw, entry.request.method.toUpperCase(), url, pageUrl, startedAt, entry.request.postData?.text ?? null)
    if (request !== null) {
      events.push(request)
      stacks++
    }
    const content = scriptBody(raw, entry)
    if (content !== null)
      scripts.push({ url, content })
  }

  return {
    entries,
    events: events.sort((a, b) => a.ts - b.ts),
    scripts,
    warnings,
    ...timeline(valid),
    stacks,
  }
}

/** The first page load, the first and last request times, and the browser's user agent. */
function timeline(valid: readonly ValidEntry[]): Pick<ConvertedHar, 'startUrl' | 'startedAt' | 'completedAt' | 'userAgent'> {
  const ordered = [...valid].sort((a, b) => a.startedAt - b.startedAt)
  const first = ordered.find(({ raw, entry }) => isDocument(raw, entry.response.content?.mimeType)) ?? ordered[0]
  const start = ordered[0]
  const last = ordered.at(-1)
  return {
    startUrl: first?.entry.request.url ?? null,
    startedAt: start === undefined
      ? null
      : new Date(start.startedAt).toISOString(),
    completedAt: last === undefined
      ? null
      : new Date(last.startedAt).toISOString(),
    userAgent: (first && header(first.entry.request.headers, 'user-agent')) ?? '',
  }
}
