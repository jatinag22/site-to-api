/**
 * Fills response bodies the HAR lost. Playwright records an empty body for a request whose page
 * navigated away before the body was fetched, which is exactly what happens after a login
 * redirect; the token in that body is what every later request needs. The instrumentation reads
 * a copy of each fetch/XHR response in the page, so those copies fill the gap.
 */
import type { Exchange, ResponseEvent } from '../model'
import { decodeBody } from './body'

/** A response event this far before the HAR start time (clock skew) or after it still matches. */
const EARLY_MS = 2_000
const LATE_MS = 120_000

function withoutFragment(url: string): string {
  const index = url.indexOf('#')
  return index === -1
    ? url
    : url.slice(0, index)
}

function bodyMissing(exchange: Exchange): boolean {
  const body = exchange.response.body
  return body === null || (body.text === null && body.base64 === null)
}

/**
 * Sets `response.body` on exchanges that have none, from the closest unused response event with
 * the same method, URL and status. Returns how many bodies were filled.
 */
export function fillMissingBodies(exchanges: Exchange[], events: ResponseEvent[]): number {
  const used = new Set<number>()
  let filled = 0
  for (const exchange of exchanges) {
    if (!bodyMissing(exchange))
      continue
    const url = withoutFragment(exchange.request.url)
    let best: { index: number, distance: number } | null = null
    events.forEach((event, index) => {
      if (used.has(index) || event.method !== exchange.request.method || event.status !== exchange.response.status)
        return
      if (withoutFragment(event.url) !== url)
        return
      const delta = event.ts - exchange.startedAt
      if (delta < -EARLY_MS || delta > LATE_MS)
        return
      const distance = Math.abs(delta)
      if (!best || distance < best.distance)
        best = { index, distance }
    })
    if (best === null)
      continue
    const { index } = best
    const event = events[index]!
    used.add(index)
    exchange.response.body = decodeBody({ contentType: event.mimeType, text: event.body })
    filled++
  }
  return filled
}
