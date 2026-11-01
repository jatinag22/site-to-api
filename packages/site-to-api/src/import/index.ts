/**
 * `site-to-api import` (decision 0057): a HAR exported from browser DevTools or a proxy becomes
 * a raw session under `<rawDir>/<session>/` that build, probe and gen read like a captured one.
 * The HAR is untrusted input: it is size-checked and validated, nothing is written outside the
 * new session folder, and the raw folder keeps its `.gitignore` of `*`.
 */
import type { ResolvedConfig } from '../config/schema'
import type { SessionMeta } from '../model'
import type { ConvertedHar } from './convert'
import type { ImportHar } from './har-input'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { compactHar, defaultSessionId, safeJoin, sanitizeSessionId, scriptFilePath } from '../capture'
import { SiteToApiError } from '../errors'
import { RAW_FORMAT_VERSION, SessionMetaSchema } from '../model'
import { convertHar } from './convert'
import { ImportHarSchema } from './har-input'

/**
 * HAR files larger than this are refused: parsing one means holding the text and the parsed
 * object in memory at once, and above this Node's default heap runs out inside `JSON.parse`
 * before the friendly message could be shown.
 */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024

const HAR_FILE = 'traffic.har'
const EVENTS_FILE = 'events.jsonl'
const META_FILE = 'meta.json'

export interface ImportHarOptions {
  /** The HAR file to import. */
  file: string
  /** Session id; default `<host>-<timestamp>` of the first page load. */
  sessionId?: string
  cwd: string
  /** Delete the HAR file once the session is saved (it holds the person's cookies). */
  deleteSource?: boolean
  /** The size limit; tests pass a small one. */
  maxBytes?: number
  now?: Date
}

export interface ImportHarResult {
  sessionDir: string
  meta: SessionMeta
  entries: number
  events: number
  scripts: number
  warnings: string[]
  /** True when `deleteSource` removed the HAR file. */
  sourceDeleted: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${bytes} bytes`
}

async function readHar(file: string, maxBytes: number): Promise<unknown> {
  let size: number
  try {
    size = (await stat(file)).size
  }
  catch (error) {
    throw new SiteToApiError(`Cannot read ${file}: ${errorMessage(error)}. Pass the path of a .har file exported from your browser's DevTools (Network tab, "Save all as HAR") or a proxy.`, { cause: error })
  }
  if (size > maxBytes)
    throw new SiteToApiError(`${file} is ${sizeLabel(size)}, over the ${sizeLabel(maxBytes)} import limit. Export a shorter session (clear the Network tab, then repeat only the pages you need).`)
  const text = await readFile(file, 'utf8')
  try {
    return JSON.parse(text) as unknown
  }
  catch (error) {
    throw new SiteToApiError(`${file} is not valid JSON (${errorMessage(error)}). A HAR file is JSON; export it again from DevTools or your proxy.`, { cause: error })
  }
}

/** A {@link SiteToApiError} naming the file for anything the checks above did not foresee. */
function unexpected(file: string, error: unknown): SiteToApiError {
  if (error instanceof SiteToApiError)
    return error
  return new SiteToApiError(`Could not import ${file}: ${errorMessage(error)}. Nothing was saved. Export the HAR again from browser DevTools or your proxy; if it still fails, report it with the exporter's name.`, { cause: error })
}

/** Creates the raw directory with a `.gitignore` of `*`, as capture does. */
async function prepareRawDir(rawDir: string): Promise<void> {
  await mkdir(rawDir, { recursive: true })
  const ignore = path.join(rawDir, '.gitignore')
  if (!existsSync(ignore))
    await writeFile(ignore, '*\n')
}

function creatorOf(value: { name?: string | null, version?: string | null } | null | undefined): string | null {
  if (!value?.name)
    return null
  return value.version
    ? `${value.name} ${value.version}`
    : value.name
}

/** Writes the session files into `dir`: script bodies, `traffic.har`, `events.jsonl` and `meta.json`. */
async function writeSession(dir: string, sessionId: string, converted: ConvertedHar, har: ImportHar, now: Date): Promise<SessionMeta> {
  // Script bodies go under scripts/ (source analysis reads them there), then asset bodies leave
  // the HAR as they do for a capture.
  const scripts: SessionMeta['scripts'] = []
  const savedFiles = new Set<string>()
  for (const script of converted.scripts) {
    let relative: string
    try {
      relative = scriptFilePath(script.url)
    }
    catch {
      continue
    }
    if (savedFiles.has(relative))
      continue
    savedFiles.add(relative)
    const target = safeJoin(dir, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, script.content)
    scripts.push({ url: script.url, file: relative, sourceMap: null })
  }
  const output = {
    log: {
      version: '1.2',
      creator: { name: 'site-to-api import', version: pkg.version },
      entries: converted.entries,
    },
  }
  compactHar(output)
  await writeFile(path.join(dir, HAR_FILE), JSON.stringify(output))
  await writeFile(path.join(dir, EVENTS_FILE), converted.events.map(event => JSON.stringify(event)).join('\n') + (converted.events.length > 0
    ? '\n'
    : ''))

  const meta = SessionMetaSchema.parse({
    formatVersion: RAW_FORMAT_VERSION,
    sessionId,
    toolVersion: pkg.version,
    startUrl: converted.startUrl,
    startedAt: converted.startedAt ?? now.toISOString(),
    completedAt: converted.completedAt ?? now.toISOString(),
    browser: { channel: null, headless: false, userAgent: converted.userAgent },
    har: HAR_FILE,
    events: EVENTS_FILE,
    scripts: scripts.toSorted((a, b) => a.url.localeCompare(b.url)),
    source: 'har-import',
    importedFrom: {
      creator: creatorOf(har.log.creator),
      browser: creatorOf(har.log.browser),
    },
  } satisfies SessionMeta)
  await writeFile(path.join(dir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}

/**
 * Imports one HAR file into a new raw session. Throws {@link SiteToApiError} for an unreadable,
 * oversized, non-JSON or non-HAR file, an existing session id, or a HAR without valid entries.
 */
export async function importHar(config: Pick<ResolvedConfig, 'rawDir'>, options: ImportHarOptions): Promise<ImportHarResult> {
  const file = path.resolve(options.cwd, options.file)
  const parsed = ImportHarSchema.safeParse(await readHar(file, options.maxBytes ?? MAX_IMPORT_BYTES))
  if (!parsed.success)
    throw new SiteToApiError(`${file} is not a HAR file: it needs a "log" object with an "entries" array (${parsed.error.issues[0]?.message ?? 'invalid'}). Export it again as HAR.`)
  let converted: ConvertedHar
  try {
    converted = convertHar(parsed.data)
  }
  catch (error) {
    throw unexpected(file, error)
  }
  if (converted.entries.length === 0) {
    throw new SiteToApiError(`${file} has no valid HAR entries to import.${converted.warnings.length > 0
      ? ` ${converted.warnings.join(' ')}`
      : ''}`)
  }

  const rawDir = path.resolve(options.cwd, config.rawDir)
  const now = options.now ?? new Date()
  const sessionId = options.sessionId === undefined
    ? defaultSessionId(converted.startUrl, now)
    : sanitizeSessionId(options.sessionId)
  const sessionDir = safeJoin(rawDir, sessionId)
  await prepareRawDir(rawDir)
  if (existsSync(sessionDir))
    throw new SiteToApiError(`Session ${sessionId} already exists in ${rawDir}. Pass a different --session or delete that folder.`)
  // The session is written into a temporary folder beside it and renamed at the end, so a
  // failure never leaves a half-written session that blocks importing again.
  const tempDir = await mkdtemp(path.join(rawDir, `.${sessionId}.importing-`))
  let meta: SessionMeta
  try {
    meta = await writeSession(tempDir, sessionId, converted, parsed.data, now)
    if (existsSync(sessionDir))
      throw new SiteToApiError(`Session ${sessionId} already exists in ${rawDir}. Pass a different --session or delete that folder.`)
    await rename(tempDir, sessionDir)
  }
  catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw unexpected(file, error)
  }

  let sourceDeleted = false
  if (options.deleteSource === true) {
    await rm(file, { force: true })
    sourceDeleted = true
  }
  return {
    sessionDir,
    meta,
    entries: converted.entries.length,
    events: converted.events.length,
    scripts: meta.scripts.length,
    warnings: converted.warnings,
    sourceDeleted,
  }
}
