/**
 * Reads raw capture sessions from disk (format: `src/model/capture.ts`).
 */
import type { CaptureEvent, Exchange, LoadedSession, RequestEvent, ResponseEvent, SessionMeta } from '../model'
import type { HarEntry } from './har'
import type { MatchableEntry } from './initiator'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SiteToApiError } from '../errors'
import { CaptureEventSchema, SessionMetaSchema } from '../model'
import { fillMissingBodies } from './bodies'
import { buildExchange } from './exchange'
import { HarEntrySchema, HarFileSchema } from './har'
import { matchRequestEvents, urlWithoutFragment } from './initiator'

interface LoadResult {
  /** Sessions sorted by start time, then id. */
  sessions: LoadedSession[]
  /** All exchanges, sorted by session (same order as `sessions`) then `startedAt`. */
  exchanges: Exchange[]
  /** Problems that did not stop loading: bad event lines, odd HAR entries, skipped folders. */
  warnings: string[]
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return null
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

function zodMessage(error: { issues: Array<{ path: PropertyKey[], message: string }> }): string {
  const issue = error.issues[0]
  if (!issue)
    return 'invalid'
  const path = issue.path.map(String).join('.')
  return path === ''
    ? issue.message
    : `${path}: ${issue.message}`
}

async function readEvents(dir: string, meta: SessionMeta, warnings: string[]): Promise<CaptureEvent[]> {
  const text = await readText(join(dir, meta.events))
  if (text === null) {
    warnings.push(`${meta.sessionId}: ${meta.events} is missing; request stacks and actions are unavailable for this session`)
    return []
  }
  const events: CaptureEvent[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '')
      return
    const parsed = CaptureEventSchema.safeParse(parseJson(line))
    if (parsed.success)
      events.push(parsed.data)
    else
      warnings.push(`${meta.sessionId}: ${meta.events} line ${index + 1} skipped (${zodMessage(parsed.error)})`)
  })
  return events
}

async function readHarEntries(dir: string, meta: SessionMeta, warnings: string[]): Promise<Array<HarEntry | null>> {
  const text = await readText(join(dir, meta.har))
  const file = HarFileSchema.safeParse(text === null
    ? undefined
    : parseJson(text))
  if (!file.success) {
    warnings.push(`${meta.sessionId}: ${meta.har} is missing or not a HAR file; the session has no traffic`)
    return []
  }
  return file.data.log.entries.map((raw, index) => {
    const entry = HarEntrySchema.safeParse(raw)
    if (entry.success)
      return entry.data
    warnings.push(`${meta.sessionId}: HAR entry ${index} skipped (${zodMessage(entry.error)})`)
    return null
  })
}

function toMatchable(entries: Array<HarEntry | null>): MatchableEntry[] {
  const matchable: MatchableEntry[] = []
  entries.forEach((entry, index) => {
    if (!entry)
      return
    const url = urlWithoutFragment(entry.request.url)
    if (url === null)
      return
    matchable.push({
      index,
      method: entry.request.method.toUpperCase(),
      url,
      startedAt: Date.parse(entry.startedDateTime),
      bodyText: entry.request.postData?.text ?? null,
    })
  })
  return matchable
}

/**
 * `dir` is absolute; warnings name the folder by its name inside the raw directory instead,
 * because they are copied into the committed `AGENT.md` and must not reveal local paths.
 */
async function loadSession(dir: string, name: string, warnings: string[]): Promise<{ session: LoadedSession, exchanges: Exchange[] } | null> {
  const metaText = await readText(join(dir, 'meta.json'))
  if (metaText === null) {
    warnings.push(`${name}: no meta.json; not a capture session, skipped`)
    return null
  }
  const meta = SessionMetaSchema.safeParse(parseJson(metaText))
  if (!meta.success) {
    warnings.push(`${name}: meta.json is invalid (${zodMessage(meta.error)}); session skipped. Capture it again with this version of site-to-api.`)
    return null
  }
  const events = await readEvents(dir, meta.data, warnings)
  const entries = await readHarEntries(dir, meta.data, warnings)
  const requestEvents = events.filter((event): event is RequestEvent => event.t === 'request')
  const matches = matchRequestEvents(toMatchable(entries), requestEvents)

  const exchanges: Exchange[] = []
  entries.forEach((entry, harIndex) => {
    if (!entry)
      return
    const exchange = buildExchange({
      entry,
      harIndex,
      sessionId: meta.data.sessionId,
      event: matches.get(harIndex),
    })
    if (exchange)
      exchanges.push(exchange)
    else
      warnings.push(`${meta.data.sessionId}: HAR entry ${harIndex} skipped (invalid URL)`)
  })
  fillMissingBodies(exchanges, events.filter((event): event is ResponseEvent => event.t === 'response'))
  exchanges.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id, 'en', { numeric: true }))
  exchanges.forEach((exchange, seq) => {
    exchange.seq = seq
  })
  return {
    session: { meta: meta.data, dir, events },
    exchanges,
  }
}

/**
 * Loads every session folder under `rawDir`: validates `meta.json` and `events.jsonl` with the
 * capture schemas, decodes the HAR into {@link Exchange}s and attaches the JavaScript stack that
 * sent each request. Bad event lines and HAR entries become warnings.
 *
 * @throws SiteToApiError when `rawDir` does not exist or holds no valid session
 */
export async function loadSessions(rawDir: string): Promise<LoadResult> {
  const root = resolve(rawDir)
  let names: string[]
  try {
    if (!(await stat(root)).isDirectory())
      throw new Error('not a directory')
    names = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  }
  catch (error) {
    throw new SiteToApiError(`Raw capture folder ${root} does not exist. Run \`site-to-api capture\` first or set rawDir.`, { cause: error })
  }

  const warnings: string[] = []
  const loaded: Array<{ session: LoadedSession, exchanges: Exchange[] }> = []
  for (const name of names) {
    const result = await loadSession(join(root, name), name, warnings)
    if (result)
      loaded.push(result)
  }
  if (loaded.length === 0)
    throw new SiteToApiError(`No capture sessions found in ${root}. Run \`site-to-api capture\` first.`)

  loaded.sort((a, b) =>
    a.session.meta.startedAt.localeCompare(b.session.meta.startedAt)
    || a.session.meta.sessionId.localeCompare(b.session.meta.sessionId))
  return {
    sessions: loaded.map(entry => entry.session),
    exchanges: loaded.flatMap(entry => entry.exchanges),
    warnings,
  }
}
