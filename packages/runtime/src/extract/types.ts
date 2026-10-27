/**
 * Extraction specs turn an HTML or text response into structured records. `site-to-api build`
 * infers them from captured samples; generated clients run them through `extract()`.
 * Kept free of dependencies so it runs anywhere, including edge workers.
 */

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date'

export interface ExtractField {
  /** CSS selector relative to the record root. Empty string means the root itself. */
  selector: string
  /** Attribute to read; `null` reads the element's trimmed text content. */
  attr: string | null
  /** Optional regex with one capture group applied to the text, e.g. `₹([\\d,.]+)`. */
  pattern: string | null
  type: FieldType
  /** True when some samples did not contain this field. */
  optional: boolean
}

export interface HtmlExtractSpec {
  kind: 'html'
  /**
   * Selector matching each record. A spec for a single record (a detail page) uses `:root`
   * and `many: false`.
   */
  records: string
  many: boolean
  fields: Record<string, ExtractField>
}

export interface TextExtractSpec {
  kind: 'text'
  /** How the text is laid out. */
  layout: 'delimited' | 'pattern'
  /** For `delimited`: the column delimiter, e.g. `,`, `|`, `\t`. */
  delimiter: string | null
  /** For `delimited`: whether the first line is a header row. */
  header: boolean
  /** For `pattern`: a regex with named groups, matched globally, one record per match. */
  pattern: string | null
  fields: Record<string, { column: number | null, group: string | null, type: FieldType, optional: boolean }>
}

export type ExtractSpec = HtmlExtractSpec | TextExtractSpec
