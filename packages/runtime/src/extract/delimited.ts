/**
 * Splits delimited text into rows of fields. Handles RFC 4180 quoting: a quoted field may contain
 * the delimiter, line breaks and doubled quotes (`""`). Blank lines are skipped.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  while (i < text.length) {
    const field = text[i] === '"'
      ? readQuoted(text, i + 1, delimiter)
      : readPlain(text, i, delimiter)
    row.push(field.value)
    i = field.end
    if (text.startsWith(delimiter, i)) {
      i += delimiter.length
      // A delimiter at the very end still opens one last, empty field.
      if (i === text.length)
        row.push('')
      continue
    }
    i += text.startsWith('\r\n', i)
      ? 2
      : 1
    if (row.length > 1 || row[0] !== '')
      rows.push(row)
    row = []
  }
  if (row.length > 0)
    rows.push(row)
  return rows
}

interface Field {
  value: string
  /** Index just after the field. */
  end: number
}

function readPlain(text: string, start: number, delimiter: string): Field {
  let end = start
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r' && !text.startsWith(delimiter, end))
    end++
  return {
    value: text.slice(start, end),
    end,
  }
}

/** Reads from just after an opening quote; text after the closing quote is kept literally. */
function readQuoted(text: string, start: number, delimiter: string): Field {
  let value = ''
  let i = start
  while (i < text.length) {
    const quote = text.indexOf('"', i)
    if (quote < 0)
      return { value: value + text.slice(i), end: text.length }
    value += text.slice(i, quote)
    if (text[quote + 1] !== '"') {
      const rest = readPlain(text, quote + 1, delimiter)
      return { value: value + rest.value, end: rest.end }
    }
    value += '"'
    i = quote + 2
  }
  return { value, end: text.length }
}
