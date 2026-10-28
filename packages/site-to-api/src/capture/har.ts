/**
 * Keeps the raw HAR to what `build` reads (decision 0031). Playwright records every response body
 * and every WebSocket frame; on a busy site most of the file is bodies nothing reads.
 */

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
