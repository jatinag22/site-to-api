import type { HtmlEngine } from './engine'
import type { ExtractField, ExtractSpec, FieldType, HtmlExtractSpec, TextExtractSpec } from './types'
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
export function extractWith<N>(engine: HtmlEngine<N>, text: string, spec: ExtractSpec): ExtractedRecord[] | ExtractedRecord {
  return spec.kind === 'html'
    ? extractHtml(engine, text, spec)
    : extractText(text, spec)
}

function extractHtml<N>(engine: HtmlEngine<N>, html: string, spec: HtmlExtractSpec): ExtractedRecord[] | ExtractedRecord {
  const document = engine.parse(html)
  const fieldPatterns = new Map<string, RegExp>()
  for (const [name, field] of Object.entries(spec.fields)) {
    if (field.pattern !== null)
      fieldPatterns.set(name, compileRegex(field.pattern, '', `field "${name}"`))
  }

  // `:root` (or no selector) means the whole page is one record; using the document node keeps
  // that working for fragments without an <html> element.
  const wholeDocument = spec.records === '' || spec.records === ':root'
  const roots: N[] = wholeDocument
    ? [document]
    : select(engine, spec.records, document, 'records')
  const records = (spec.many
    ? roots
    : roots.slice(0, 1)).map((root) => {
    const record = newRecord()
    for (const [name, field] of Object.entries(spec.fields)) {
      const raw = readField(engine, root, field, fieldPatterns.get(name) ?? null, name)
      assign(record, name, raw, field.type, field.optional)
    }
    return record
  })
  if (spec.many)
    return records
  return records[0] ?? emptyRecord(spec.fields)
}

function readField<N>(engine: HtmlEngine<N>, root: N, field: ExtractField, pattern: RegExp | null, name: string): string | null {
  const node = field.selector === ''
    ? root
    : selectFirst(engine, field.selector, root, `field "${name}"`)
  if (node === null)
    return null
  const value = field.attr === null
    ? collapse(engine.text(node))
    : engine.attribute(node, field.attr)
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
      const record = newRecord()
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
    const record = newRecord()
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

/**
 * An empty record without a prototype. Field names come from page text, so a record must not
 * inherit `constructor` or `toString` (a missing optional field would read as a function and
 * fail the generated client's schema), and `__proto__` must be stored like any other name.
 */
function newRecord(): ExtractedRecord {
  const record: ExtractedRecord = Object.create(null)
  return record
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
  const record = newRecord()
  for (const [name, field] of Object.entries(fields)) {
    if (!field.optional)
      record[name] = null
  }
  return record
}

function select<N>(engine: HtmlEngine<N>, selector: string, root: N, what: string): N[] {
  try {
    return engine.selectAll(selector, root)
  }
  catch (error) {
    throw new TypeError(`extract: invalid CSS selector for ${what}: ${JSON.stringify(selector)}`, { cause: error })
  }
}

function selectFirst<N>(engine: HtmlEngine<N>, selector: string, root: N, what: string): N | null {
  try {
    return engine.selectOne(selector, root)
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

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
