/**
 * Keeps the raw HAR to what `build` reads (decision 0031). Playwright records every response body
 * and every WebSocket frame; on a busy site most of the file is bodies nothing reads.
 */

import type { Navigation } from '../load'
import { readFile as readFileDefault, rename, rm, stat, writeFile as writeFileDefault } from 'node:fs/promises'
import { z } from 'zod'
import { SiteToApiError } from '../errors'
import { harNavigations } from '../load'

/** Resource types classified as assets by type alone: their bodies are never read from the HAR. */
const ASSET_RESOURCE_TYPES = new Set([
  'image',
  'font',
  'stylesheet',
  'media',
  'script',
])

/** What compaction removed, for the capture log. */
export interface HarCompaction {
  entries: number
  /** Response bodies of asset entries dropped (scripts are saved under `scripts/` instead). */
  bodiesOmitted: number
  /** WebSocket frames dropped; `events.jsonl` holds them. */
  framesOmitted: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Removes from a parsed HAR, in place, what `build` never reads from it: the response body of
 * asset entries (`_resourceType` image, font, stylesheet, media or script; size and media type
 * stay, and `comment` says the body was omitted) and Playwright's `_webSocketMessages`. Bodies
 * of documents, fetch and XHR calls stay, since classification and analysis read them.
 */
export function compactHar(har: { log: { entries: unknown[] } }): HarCompaction {
  const result: HarCompaction = { entries: har.log.entries.length, bodiesOmitted: 0, framesOmitted: 0 }
  for (const entry of har.log.entries) {
    if (!isRecord(entry))
      continue
    const frames = entry._webSocketMessages
    if (Array.isArray(frames)) {
      result.framesOmitted += frames.length
      delete entry._webSocketMessages
    }
    const response = entry.response
    const content = isRecord(response)
      ? response.content
      : undefined
    const resourceType = entry._resourceType
    if (typeof resourceType !== 'string' || !ASSET_RESOURCE_TYPES.has(resourceType) || !isRecord(content))
      continue
    if (typeof content.text !== 'string' || content.text === '')
      continue
    delete content.text
    delete content.encoding
    content.comment = 'body omitted by site-to-api: asset'
    result.bodiesOmitted++
  }
  return result
}

const HarSchema = z.object({
  log: z.object({
    entries: z.array(z.unknown()),
  }),
})

function isHarDocument(value: unknown): value is { log: { entries: unknown[] } } {
  return HarSchema.safeParse(value).success
}

/** File operations {@link finishHar} uses; tests replace `writeFile` to fail midway. */
export interface HarFiles {
  readFile: (file: string, encoding: 'utf8') => Promise<string>
  writeFile: (file: string, data: string) => Promise<void>
}

const NODE_FILES: HarFiles = { readFile: readFileDefault, writeFile: writeFileDefault }

/** What {@link finishHar} did: the compaction applied, or a warning when it could not be saved. */
export interface FinishedHar extends HarCompaction {
  /** Request bodies put back from their raw bytes (`postData._base64`, decision 0049). */
  bodiesRestored: number
  /** One warning when the compacted HAR could not be written; the original HAR is then kept. */
  warnings: string[]
  /** Top-level page loads, to tell a capture the site blocked (decision 0037). */
  navigations: Navigation[]
}

/**
 * Checks the HAR the browser wrote, then compacts it (decision 0031). The compacted file is
 * written next to the original and renamed over it, so a crash, a second Ctrl+C or a full disk
 * mid-write leaves the original HAR whole instead of a truncated one. A failed write is not
 * fatal: the session keeps the uncompacted HAR and the result carries a warning. `restoreBodies`
 * puts back request bodies Playwright could not write as text (see `bodies.ts`).
 */
export async function finishHar(file: string, files: HarFiles = NODE_FILES, restoreBodies: (entries: unknown[]) => number = () => 0): Promise<FinishedHar> {
  let size = 0
  try {
    size = (await stat(file)).size
  }
  catch {
    throw new SiteToApiError(`The browser closed without writing ${file}. Capture again and end the session by closing the browser window or pressing Ctrl+C, not by killing the process.`)
  }
  if (size === 0)
    throw new SiteToApiError(`${file} is empty. Capture again and end the session by closing the browser window or pressing Ctrl+C.`)
  const har: unknown = JSON.parse(await files.readFile(file, 'utf8'))
  // The document itself, not Zod's copy: that one drops every field the schema does not list.
  if (!isHarDocument(har))
    throw new SiteToApiError(`${file} is not a valid HAR file. Capture again.`)
  const navigations = harNavigations(har.log.entries)
  const compaction = compactHar(har)
  const bodiesRestored = restoreBodies(har.log.entries)
  if (compaction.bodiesOmitted === 0 && compaction.framesOmitted === 0 && bodiesRestored === 0) {
    return {
      ...compaction,
      bodiesRestored,
      warnings: [],
      navigations,
    }
  }
  const temporary = `${file}.tmp`
  try {
    await files.writeFile(temporary, JSON.stringify(har))
    await rename(temporary, file)
  }
  catch (error) {
    // A leftover temporary file is harmless; failing the capture over it would lose the session.
    const cleanup = await rm(temporary, { force: true }).then(() => '', () => ` ${temporary} may be left behind.`)
    const reason = error instanceof Error
      ? error.message
      : String(error)
    return {
      entries: compaction.entries,
      bodiesOmitted: 0,
      framesOmitted: 0,
      bodiesRestored: 0,
      warnings: [`Could not save the compacted HAR (${reason}); kept the original ${file} with every body and frame.${cleanup}`],
      navigations,
    }
  }
  return {
    ...compaction,
    bodiesRestored,
    warnings: [],
    navigations,
  }
}

/**
 * The capture log line about what compaction left out, or null when nothing was. It says where
 * frames and scripts are only when the capture kept them.
 */
export function harOmissionNote(compaction: HarCompaction, kept: { websockets: boolean, saveScripts: boolean, eventsFile: string }): string | null {
  if (compaction.bodiesOmitted === 0 && compaction.framesOmitted === 0)
    return null
  const frames = kept.websockets
    ? `the frames are in ${kept.eventsFile}`
    : 'frames are not kept: capture.websockets is off'
  const scripts = kept.saveScripts
    ? 'the scripts under scripts/'
    : 'scripts are not kept: capture.saveScripts is off'
  return `Left ${compaction.bodiesOmitted} asset bodies and ${compaction.framesOmitted} WebSocket frames out of the HAR (${frames}; ${scripts}).`
}
