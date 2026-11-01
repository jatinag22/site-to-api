import type { HtmlEngine } from './engine'
import { extractWith } from './extract'

/** Where a single value sits in an HTML page: the `html` origins of `flows.json`. */
export interface HtmlValueLocation {
  /** CSS selector of the element; the first match is read. */
  selector: string
  /** Attribute to read; `null` reads the element's text with whitespace collapsed. */
  attr: string | null
  /** Optional regex applied to the value; the first capture group is kept. */
  pattern: string | null
}

/**
 * {@link extractValue} with the given HTML engine. Reads one value from an HTML page, such as a CSRF token in
 * `<meta name="csrf-token" content="...">`. Uses the same rules as {@link extract}, so it reads
 * exactly what `site-to-api build` verified. Returns `null` when the element, the attribute or
 * the pattern does not match. Throws a `TypeError` for an invalid selector or pattern.
 *
 * ```ts
 * const csrf = extractValue(html, { selector: 'meta[name="csrf-token"]', attr: 'content', pattern: null })
 * ```
 */
export function extractValueWith<N>(engine: HtmlEngine<N>, html: string, location: HtmlValueLocation): string | null {
  const record = extractWith(engine, html, {
    kind: 'html',
    records: ':root',
    many: false,
    fields: {
      value: { ...location, type: 'string', optional: true },
    },
  })
  const value = Array.isArray(record)
    ? undefined
    : record.value
  return typeof value === 'string'
    ? value
    : null
}
