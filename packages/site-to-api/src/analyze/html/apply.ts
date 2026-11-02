/**
 * Runs an extraction spec over a document. `build` uses it to verify every inferred spec against
 * the samples it came from; the semantics below are what the runtime's `extract()` must match.
 */
import type { ExtractField, ExtractSpec, HtmlExtractSpec, TextExtractSpec } from 'site-to-api-runtime'
import type { Document, Element } from './dom'
import type { ExtractedValue } from './values'
import { isTag } from 'domhandler'
import { attr, parseHtml, select, selectFirst, text } from './dom'
import { capture } from './pattern'
import { coerce } from './values'

/** One extracted record; a field that is missing or does not fit its type is `null`. */
type ExtractedRecord = Record<string, ExtractedValue | null>

/**
 * The text a field reads before type coercion: the element (empty selector: the root itself),
 * its text with whitespace collapsed (as the runtime's `extract()` reads it) or an attribute,
 * then the pattern's first group. `null` when any step finds nothing.
 */
export function readRaw(root: Document | Element, selector: string, attrName: string | null, pattern: string | null): string | null {
  const element = selector === ''
    ? root
    : selectFirst(selector, root)
  if (!element)
    return null
  let raw: string | null
  if (attrName === null) {
    // A comment that spans lines must read the same here as in a generated client.
    raw = text(element).replace(/\s+/g, ' ')
  }
  else {
    raw = isTag(element)
      ? attr(element, attrName)
      : null
  }
  return raw !== null && pattern !== null
    ? capture(pattern, raw)
    : raw
}

function readField(root: Document | Element, field: ExtractField): ExtractedValue | null {
  const raw = readRaw(root, field.selector, field.attr, field.pattern)
  return raw === null
    ? null
    : coerce(raw, field.type)
}

function applyHtml(input: string, spec: HtmlExtractSpec): ExtractedRecord[] {
  const document = parseHtml(input)
  let roots: Array<Document | Element>
  if (spec.many) {
    roots = select(spec.records, document)
  }
  else if (spec.records === ':root') {
    roots = [document]
  }
  else {
    const first = selectFirst(spec.records, document)
    roots = first
      ? [first]
      : []
  }
  return roots.map(root => Object.fromEntries(
    Object.entries(spec.fields).map(([name, field]) => [
      name,
      readField(root, field),
    ]),
  ))
}

/** Splits one delimited line; double quotes group text containing the delimiter (`""` escapes). */
export function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i)
    if (quoted) {
      if (ch === '"' && line.charAt(i + 1) === '"') {
        cell += '"'
        i++
      }
      else if (ch === '"') {
        quoted = false
      }
      else {
        cell += ch
      }
    }
    else if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    }
    else if (line.startsWith(delimiter, i)) {
      cells.push(cell)
      cell = ''
      i += delimiter.length - 1
    }
    else {
      cell += ch
    }
  }
  cells.push(cell)
  return cells
}

/** Non-blank lines without their line breaks. */
export function textLines(input: string): string[] {
  return input.split(/\r?\n/).filter(line => line.trim() !== '')
}

function applyText(input: string, spec: TextExtractSpec): ExtractedRecord[] {
  const entries = Object.entries(spec.fields)
  if (spec.layout === 'delimited') {
    const delimiter = spec.delimiter ?? ','
    const rows = textLines(input).slice(spec.header ? 1 : 0).map(line => splitDelimited(line, delimiter))
    return rows.map(cells => Object.fromEntries(entries.map(([name, field]) => {
      const cell = field.column === null
        ? undefined
        : cells[field.column]
      return [
        name,
        cell === undefined
          ? null
          : coerce(cell, field.type),
      ]
    })))
  }
  if (spec.pattern === null)
    return []
  return [
    ...input.matchAll(new RegExp(spec.pattern, 'g')),
  ].map(match => Object.fromEntries(entries.map(([name, field]) => {
    const value = field.group === null
      ? undefined
      : match.groups?.[field.group]
    return [
      name,
      value === undefined
        ? null
        : coerce(value, field.type),
    ]
  })))
}

/**
 * Extracts records from an HTML or text document.
 *
 * HTML: with `many`, every element matching `records` is a record; otherwise `:root` means the
 * whole document and any other selector its first match. A field's `selector` is matched among
 * the record's descendants (empty string: the record itself), `attr: null` reads the text
 * content with whitespace collapsed, `pattern` keeps its first capture group, and the result is coerced to `type`
 * (see `coerce`). Text: `delimited` splits non-blank lines by `delimiter` (double quotes group,
 * the first line is skipped when `header`), `pattern` is matched with the `g` flag and named
 * groups give the fields.
 */
export function applyExtractSpec(input: string, spec: ExtractSpec): ExtractedRecord[] {
  return spec.kind === 'html'
    ? applyHtml(input, spec)
    : applyText(input, spec)
}
