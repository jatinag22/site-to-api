/**
 * Extraction specs for plain-text responses: delimited tables (CSV, TSV, pipe, semicolon) with
 * header detection, and `key: value` layouts (one record per line or per blank-line block).
 */
import type { FieldType, TextExtractSpec } from '@site-to-api/runtime'
import type { ExtractedValue } from './values'
import { splitDelimited, textLines } from './apply'
import { camelCase, NameAllocator } from './naming'
import { escapeRegex } from './pattern'
import { coerce, inferType } from './values'

/** A text spec with the values it should extract, for verification. */
export interface TextDraft {
  spec: TextExtractSpec
  expected: Record<string, Array<ExtractedValue | null>>
  /** True when the layout is a table or label/value pairs, which one sample may establish. */
  structured: boolean
}

const DELIMITERS = [',', '\t', '|', ';']
const PAIR_SEPARATORS = ['|', ';', '\t', ',']

function columnsOf(lines: string[], delimiter: string): number | null {
  const counts = new Set(lines.map(line => splitDelimited(line, delimiter).length))
  const [count] = counts
  return counts.size === 1 && count !== undefined && count >= 2
    ? count
    : null
}

/** The delimiter that splits every line of every sample into the same number of columns. */
function detectDelimiter(samples: string[][]): { delimiter: string, columns: number } | null {
  let best: { delimiter: string, columns: number } | null = null
  for (const delimiter of DELIMITERS) {
    const perSample = samples.map(lines => columnsOf(lines, delimiter))
    const [columns] = perSample
    if (columns === null || columns === undefined || perSample.some(count => count !== columns))
      continue
    if (!best || columns > best.columns)
      best = { delimiter, columns }
  }
  return best
}

function isLabelLike(cell: string): boolean {
  return /^[a-z_][\w .()/#%-]{0,40}$/i.test(cell.trim())
}

/**
 * A header row has distinct label-like cells that do not parse as data, and either the data
 * below has typed columns, every sample starts with the same row, or the cells never repeat in
 * their column.
 */
function hasHeader(samples: string[][][]): boolean {
  const firstRows = samples.map(rows => rows[0] ?? [])
  const [first] = firstRows
  if (!first || samples.some(rows => rows.length < 2))
    return false
  const cells = first.map(cell => cell.trim())
  if (cells.some(cell => !isLabelLike(cell) || inferType([cell]) !== 'string') || new Set(cells).size !== cells.length)
    return false
  const body = samples.flatMap(rows => rows.slice(1))
  const typedColumn = cells.some((_, column) => inferType(body.map(row => row[column] ?? '')) !== 'string')
  const sameStart = samples.length > 1 && firstRows.every(row => row.join('\u0000') === first.join('\u0000'))
  const neverRepeats = cells.every((cell, column) => body.every(row => (row[column] ?? '').trim() !== cell))
  return typedColumn || sameStart || neverRepeats
}

function delimitedDraft(samples: string[]): TextDraft | null {
  const lines = samples.map(textLines)
  // One line is a sentence as often as a table; a table needs at least two rows somewhere.
  if (lines.every(sample => sample.length < 2))
    return null
  const detected = detectDelimiter(lines)
  if (!detected)
    return null
  const rows = lines.map(sample => sample.map(line => splitDelimited(line, detected.delimiter)))
  const header = hasHeader(rows)
  const body = rows.flatMap(sample => sample.slice(header ? 1 : 0))
  const names = new NameAllocator()
  const fields: TextExtractSpec['fields'] = {}
  const expected: TextDraft['expected'] = {}
  for (let column = 0; column < detected.columns; column++) {
    const cells = body.map(row => (row[column] ?? '').trim())
    if (cells.every(cell => cell === ''))
      continue
    const type = inferType(cells)
    const name = names.take(header ? rows[0]?.[0]?.[column] : null)
    const values = cells.map(cell => coerce(cell, type))
    fields[name] = {
      column,
      group: null,
      type,
      optional: values.includes(null),
    }
    expected[name] = values
  }
  return {
    spec: {
      kind: 'text',
      layout: 'delimited',
      delimiter: detected.delimiter,
      header,
      pattern: null,
      fields,
    },
    expected,
    structured: true,
  }
}

interface Pair {
  key: string
  value: string
}

const KEY = /^[a-z][\w .()/-]{0,40}$/i

/** `key: value` or `key=value`, split at the first `:` or `=`. */
function parsePair(part: string): Pair | null {
  const at = part.search(/[:=]/)
  if (at === -1)
    return null
  const key = part.slice(0, at).trim()
  return KEY.test(key)
    ? {
        key,
        value: part.slice(at + 1).trim(),
      }
    : null
}

function pairsOf(line: string, separator: string): Pair[] | null {
  const pairs: Pair[] = []
  for (const part of splitDelimited(line, separator)) {
    const pair = parsePair(part)
    if (!pair)
      return null
    pairs.push(pair)
  }
  return pairs
}

/** Records as lists of pairs: one record per line (`a: 1 | b: 2`) or per blank-line block. */
function pairRecords(sample: string): { records: Pair[][], separator: string | null } | null {
  const lines = textLines(sample)
  for (const separator of PAIR_SEPARATORS) {
    const records = lines.map(line => pairsOf(line, separator))
    if (records.every((record): record is Pair[] => record !== null && record.length >= 2))
      return { records, separator }
  }
  const blocks = sample.split(/\r?\n\s*\n/).map(block => textLines(block)).filter(block => block.length > 0)
  const records = blocks.map(block => block.map(parsePair))
  if (records.length > 0 && records.every(record => record.length >= 2 && record.every(pair => pair !== null))) {
    return {
      records: records.map(record => record.filter((pair): pair is Pair => pair !== null)),
      separator: null,
    }
  }
  return null
}

function sameKeys(records: Pair[][]): string[] | null {
  const [first] = records
  if (!first)
    return null
  const keys = first.map(pair => pair.key)
  return records.every(record => record.length === keys.length && record.every((pair, index) => pair.key === keys[index]))
    ? keys
    : null
}

function pairPattern(keys: string[], groups: string[], separator: string | null): string {
  const valueClass = separator === null
    ? '[^\\n]'
    : `[^\\n${escapeRegex(separator)}]`
  const parts = keys.map((key, index) => `${escapeRegex(key)}[ \\t]*[:=][ \\t]*(?<${groups[index]}>${valueClass}*?)`)
  const join = separator === null
    ? '[ \\t]*\\r?\\n[ \\t]*'
    : `[ \\t]*${escapeRegex(separator)}[ \\t]*`
  return `(?:^|\\n)[ \\t]*${parts.join(join)}[ \\t]*(?=\\r?\\n|$)`
}

function pairDraft(samples: string[]): TextDraft | null {
  const parsed = samples.map(pairRecords)
  if (parsed.includes(null))
    return null
  const separators = new Set(parsed.map(sample => sample?.separator))
  const records = parsed.flatMap(sample => sample?.records ?? [])
  const keys = sameKeys(records)
  const [separator] = separators
  if (!keys || separators.size !== 1 || separator === undefined)
    return null
  const names = new NameAllocator()
  const groups = keys.map(key => names.take(camelCase(key)))
  const fields: TextExtractSpec['fields'] = {}
  const expected: TextDraft['expected'] = {}
  groups.forEach((group, index) => {
    const cells = records.map(record => record[index]?.value ?? '')
    const type: FieldType = inferType(cells)
    const values = cells.map(cell => coerce(cell, type))
    fields[group] = {
      column: null,
      group,
      type,
      optional: values.includes(null),
    }
    expected[group] = values
  })
  return {
    spec: {
      kind: 'text',
      layout: 'pattern',
      delimiter: null,
      header: false,
      pattern: pairPattern(keys, groups, separator),
      fields,
    },
    expected,
    structured: true,
  }
}

/** A spec for text samples, or `null` for prose and anything without a regular layout. */
export function inferText(samples: string[]): TextDraft | null {
  if (samples.every(sample => textLines(sample).length === 0))
    return null
  return pairDraft(samples) ?? delimitedDraft(samples)
}
