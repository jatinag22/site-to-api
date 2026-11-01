import type { ExtractedRecord } from './extract'
import type { ExtractSpec } from './types'
import type { HtmlValueLocation } from './value'
import { domEngine } from './dom'
import { extractWith } from './extract'
import { extractValueWith } from './value'

/** {@link extractWith} on the browser's `DOMParser`: the `browser` build of the runtime. */
export function extract(text: string, spec: ExtractSpec): ExtractedRecord[] | ExtractedRecord {
  return extractWith(domEngine, text, spec)
}

/** {@link extractValueWith} on the browser's `DOMParser`: the `browser` build of the runtime. */
export function extractValue(html: string, location: HtmlValueLocation): string | null {
  return extractValueWith(domEngine, html, location)
}
