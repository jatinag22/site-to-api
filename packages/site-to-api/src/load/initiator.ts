/**
 * Matches instrumentation `request` events to HAR entries, so each exchange knows which code sent it.
 */
import type { RequestEvent } from '../model'

/** Events and entries further apart than this are never the same request. */
const MATCH_WINDOW_MS = 3000

/** Same length as the instrumentation's body preview. */
const PREVIEW_LENGTH = 2048

export interface MatchableEntry {
  index: number
  method: string
  /** Absolute URL without fragment. */
  url: string
  startedAt: number
  bodyText: string | null
}

/** Absolute URL without its fragment; `null` when it cannot be parsed. */
export function urlWithoutFragment(url: string, base?: string): string | null {
  try {
    const parsed = new URL(url, base)
    parsed.hash = ''
    return parsed.toString()
  }
  catch {
    return null
  }
}

interface Candidate {
  eventIndex: number
  entryIndex: number
  bodyMismatch: boolean
  distance: number
}

/**
 * Pairs events with entries one to one. Candidates share method and URL and lie within
 * {@link MATCH_WINDOW_MS}; among them the closest in time wins. A differing body preview demotes
 * a candidate below every matching one, because concurrent requests to the same URL often start
 * within the same millisecond and only their bodies tell them apart.
 *
 * @returns event per HAR entry index
 */
export function matchRequestEvents(entries: MatchableEntry[], events: RequestEvent[]): Map<number, RequestEvent> {
  const candidates: Candidate[] = []
  events.forEach((event, eventIndex) => {
    const url = urlWithoutFragment(event.url, event.pageUrl)
    if (url === null)
      return
    const method = event.method.toUpperCase()
    for (const entry of entries) {
      if (entry.method !== method || entry.url !== url)
        continue
      const distance = Math.abs(entry.startedAt - event.ts)
      if (distance > MATCH_WINDOW_MS)
        continue
      const entryPreview = entry.bodyText?.slice(0, PREVIEW_LENGTH) ?? null
      const eventPreview = event.bodyPreview?.slice(0, PREVIEW_LENGTH) ?? null
      const bodyMismatch = entryPreview !== null && eventPreview !== null && entryPreview !== eventPreview
      candidates.push({
        eventIndex,
        entryIndex: entry.index,
        bodyMismatch,
        distance,
      })
    }
  })
  candidates.sort((a, b) =>
    Number(a.bodyMismatch) - Number(b.bodyMismatch)
    || a.distance - b.distance
    || a.eventIndex - b.eventIndex
    || a.entryIndex - b.entryIndex)

  const usedEvents = new Set<number>()
  const matches = new Map<number, RequestEvent>()
  for (const candidate of candidates) {
    if (usedEvents.has(candidate.eventIndex) || matches.has(candidate.entryIndex))
      continue
    usedEvents.add(candidate.eventIndex)
    matches.set(candidate.entryIndex, events[candidate.eventIndex]!)
  }
  return matches
}
