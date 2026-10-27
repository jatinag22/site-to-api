import type { AnyNode, Element } from 'domhandler'
import type { ExtractField, ExtractSpec, FieldType, HtmlExtractSpec, TextExtractSpec } from './types'
import { selectAll, selectOne } from 'css-select'
import { getAttributeValue, textContent } from 'domutils'
import { parseDocument } from 'htmlparser2'
import { coerce } from './coerce'
import { parseDelimited } from './delimited'

/** One extracted record: field name to coerced value. */
export type ExtractedRecord = Record<string, unknown>

/**
 * Turns an HTML or text response into records, following a spec that `site-to-api build`
 * inferred from captured samples.
 *
 * - HTML: each element matching `spec.records` is a record; each field's selector is matched
 *   inside it (an empty selector means the record element itself). `attr: null` reads the text
 *   with whitespace collapsed; `pattern` keeps the first capture group.
 * - Text: `delimited` splits rows and columns (quoted CSV fields are handled); `pattern` matches a
 *   regex with named groups globally (flags `gm`), one record per match.
 * - Values are coerced to the field type. A field that is absent is left out when optional and
 *   set to `null` when required; a number or boolean that cannot be read is `null`.
 *
 * Returns an array, or a single record for an HTML spec with `many: false`.
 * Throws a `TypeError` when the spec holds an invalid selector or regex.
 */
export function extract(text: string, spec: ExtractSpec): ExtractedRecord[] | ExtractedRecord {
  return spec.kind === 'html'
    ? extractHtml(text, spec)
    : extractText(text, spec)
}

function extractHtml(html: string, spec: HtmlExtractSpec): ExtractedRecord[] | ExtractedRecord {
  const document = parseDocument(html)
  const fieldPatterns = new Map<string, RegExp>()
  for (const [name, field] of Object.entries(spec.fields)) {
    if (field.pattern !== null)
      fieldPatterns.set(name, compileRegex(field.pattern, '', `field "${name}"`))
  }

  // `:root` (or no selector) means the whole page is one record; using the document node keeps
  // that working for fragments without an <html> element.
  const wholeDocument = spec.records === '' || spec.records === ':root'
  const roots: AnyNode[] = wholeDocument
    ? [document]
    : select(spec.records, document, 'records')
  const records = (spec.many
    ? roots
    : roots.slice(0, 1)).map((root) => {
    const record: ExtractedRecord = {}
    for (const [name, field] of Object.entries(spec.fields)) {
      const raw = readField(root, field, fieldPatterns.get(name) ?? null, name)
      assign(record, name, raw, field.type, field.optional)
    }
    return record
  })
  if (spec.many)
    return records
  return records[0] ?? emptyRecord(spec.fields)
}

function readField(root: AnyNode, field: ExtractField, pattern: RegExp | null, name: string): string | null {
  const node = field.selector === ''
    ? root
    : selectFirst(field.selector, root, `field "${name}"`)
  if (node === null)
    return null
  let value: string | null
  if (field.attr === null) {
    value = collapse(textContent(node))
  }
  else {
    value = isElement(node)
      ? getAttributeValue(node, field.attr) ?? null
      : null
  }
  if (value === null || pattern === null)
    return value
  const match = pattern.exec(value)
  if (!match)
    return null
  return (match.length > 1
    ? match[1]
    : match[0]) ?? null
}

function extractText(text: string, spec: TextExtractSpec): ExtractedRecord[] {
  const fields = Object.entries(spec.fields)
  if (spec.layout === 'delimited') {
    const rows = parseDelimited(text, spec.delimiter ?? ',')
    return (spec.header
      ? rows.slice(1)
      : rows).map((row) => {
      const record: ExtractedRecord = {}
      for (const [name, field] of fields) {
        const cell = field.column === null
          ? undefined
          : row[field.column]
        assign(record, name, cell === undefined
          ? null
          : cell.trim(), field.type, field.optional)
      }
      return record
    })
  }

  if (spec.pattern === null)
    throw new TypeError('extract: a text spec with layout "pattern" needs a pattern')
  const regex = compileRegex(spec.pattern, 'gm', 'records')
  const records: ExtractedRecord[] = []
  for (const match of text.matchAll(regex)) {
    const record: ExtractedRecord = {}
    for (const [name, field] of fields) {
      const value = field.group === null
        ? undefined
        : match.groups?.[field.group]
      assign(record, name, value === undefined
        ? null
        : value.trim(), field.type, field.optional)
    }
    records.push(record)
  }
  return records
}

function assign(record: ExtractedRecord, name: string, raw: string | null, type: FieldType, optional: boolean): void {
  if (raw === null) {
    if (!optional)
      record[name] = null
    return
  }
  record[name] = coerce(raw, type)
}

function emptyRecord(fields: Record<string, ExtractField>): ExtractedRecord {
  const record: ExtractedRecord = {}
  for (const [name, field] of Object.entries(fields)) {
    if (!field.optional)
      record[name] = null
  }
  return record
}

function select(selector: string, root: AnyNode, what: string): Element[] {
  try {
    return selectAll<AnyNode, Element>(selector, root)
  }
  catch (error) {
    throw new TypeError(`extract: invalid CSS selector for ${what}: ${JSON.stringify(selector)}`, { cause: error })
  }
}

function selectFirst(selector: string, root: AnyNode, what: string): Element | null {
  try {
    return selectOne<AnyNode, Element>(selector, root)
  }
  catch (error) {
    throw new TypeError(`extract: invalid CSS selector for ${what}: ${JSON.stringify(selector)}`, { cause: error })
  }
}

function compileRegex(source: string, flags: string, what: string): RegExp {
  try {
    return new RegExp(source, flags)
  }
  catch (error) {
    throw new TypeError(`extract: invalid pattern for ${what}: ${JSON.stringify(source)}`, { cause: error })
  }
}

function isElement(node: AnyNode): node is Element {
  return 'attribs' in node
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
