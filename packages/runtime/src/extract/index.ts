import type { ExtractedRecord } from './extract'
import type { ExtractSpec } from './types'
import type { HtmlValueLocation } from './value'
import { domEngine } from './dom'
import { extractWith } from './extract'
import { htmlparser2Engine } from './htmlparser2'
import { extractValueWith } from './value'

export type { HtmlEngine } from './engine'
export type { ExtractedRecord } from './extract'
export type { ExtractField, ExtractSpec, FieldType, HtmlExtractSpec, TextExtractSpec } from './types'
export type { HtmlValueLocation } from './value'

/** The browser's `DOMParser` where there is one, htmlparser2 elsewhere (Node, Bun, Deno, workers). */
function useDom(): boolean {
  return typeof DOMParser === 'function'
}

/**
 * Turns an HTML or text response into records, following a spec that `site-to-api build`
 * inferred from captured samples. See `extractWith` in `./extract` for the rules. HTML is parsed
 * with the browser's `DOMParser` when there is one and with htmlparser2 otherwise; browser
 * bundlers pick the `browser` build, which has no htmlparser2 at all.
 */
export function extract(text: string, spec: ExtractSpec): ExtractedRecord[] | ExtractedRecord {
  return useDom()
    ? extractWith(domEngine, text, spec)
    : extractWith(htmlparser2Engine, text, spec)
}

/**
 * Reads one value from an HTML page, such as a CSRF token in
 * `<meta name="csrf-token" content="...">`, with the same rules as {@link extract}. Returns
 * `null` when the element, the attribute or the pattern does not match; throws a `TypeError` for
 * an invalid selector or pattern.
 *
 * ```ts
 * const csrf = extractValue(html, { selector: 'meta[name="csrf-token"]', attr: 'content', pattern: null })
 * ```
 */
export function extractValue(html: string, location: HtmlValueLocation): string | null {
  return useDom()
    ? extractValueWith(domEngine, html, location)
    : extractValueWith(htmlparser2Engine, html, location)
}
