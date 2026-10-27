/**
 * Type coercion for extracted values and type inference from samples. The coercion rules are
 * the contract the runtime's `extract()` must follow; they are documented on {@link coerce}.
 */
import type { FieldType } from '@site-to-api/runtime'

/** A value after type coercion. */
export type ExtractedValue = string | number | boolean

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/
const D_MON_Y = /^(\d{1,2})[\s-]+([a-z]{3,9})\.?[\s,-]+(\d{4})$/i
const MON_D_Y = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1)
    return null
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day > days
    ? null
    : `${year}-${pad(month)}-${pad(day)}`
}

/** 1-12 for a full or three-letter English month name (`Sept` too), else `null`. */
function monthNumber(name: string): number | null {
  const lower = name.toLowerCase()
  const index = MONTHS.findIndex(month => lower === month || lower === month.slice(0, 3) || (lower === 'sept' && month === 'september'))
  return index === -1
    ? null
    : index + 1
}

/** Parses the date formats `coerce` accepts; returns ISO `YYYY-MM-DD` (or the ISO input as-is). */
export function parseDate(value: string): string | null {
  if (ISO_DATE.test(value)) {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number)
    return isoDate(year ?? 0, month ?? 0, day ?? 0) === null
      ? null
      : value
  }
  const dmy = DMY.exec(value)
  if (dmy) {
    const year = Number(dmy[3])
    return isoDate(year < 100
      ? 2000 + year
      : year, Number(dmy[2]), Number(dmy[1]))
  }
  const dMonY = D_MON_Y.exec(value)
  if (dMonY) {
    const month = monthNumber(dMonY[2] ?? '')
    return month === null
      ? null
      : isoDate(Number(dMonY[3]), month, Number(dMonY[1]))
  }
  const monDY = MON_D_Y.exec(value)
  if (monDY) {
    const month = monthNumber(monDY[1] ?? '')
    return month === null
      ? null
      : isoDate(Number(monDY[3]), month, Number(monDY[2]))
  }
  return null
}

/**
 * Converts extracted text to a field type, or `null` when it does not fit:
 * - every type: the text is trimmed; an empty string is `null`.
 * - `integer` / `number`: commas and whitespace are removed (thousands separators), then the rest
 *   must be a plain decimal number (`-12`, `1200.50`, `.5`). Currency symbols and units are not
 *   stripped here; inferred specs carry a `pattern` for that.
 * - `boolean`: `true`/`yes`/`y` → true, `false`/`no`/`n` → false (any case).
 * - `date`: ISO dates and date-times are returned unchanged; `d/m/yyyy`, `d-m-yy`, `d.m.yyyy`
 *   (day first), `12 Mar 2024` and `Mar 12, 2024` become `YYYY-MM-DD`.
 */
export function coerce(raw: string, type: FieldType): ExtractedValue | null {
  const value = raw.trim()
  if (value === '')
    return null
  switch (type) {
    case 'string':
      return value
    case 'integer': {
      const digits = value.replace(/[,\s]/g, '')
      return /^[+-]?\d+$/.test(digits)
        ? Number(digits)
        : null
    }
    case 'number': {
      const digits = value.replace(/[,\s]/g, '')
      return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(digits)
        ? Number(digits)
        : null
    }
    case 'boolean':
      if (/^(?:true|yes|y)$/i.test(value))
        return true
      return /^(?:false|no|n)$/i.test(value)
        ? false
        : null
    case 'date':
      return parseDate(value)
  }
}

/** Numbers that are identifiers in disguise: leading zeros or more digits than a double holds. */
function looksLikeCode(value: string): boolean {
  const digits = value.replace(/[,\s]/g, '')
  return /^[+-]?0\d/.test(digits) || digits.replace(/\D/g, '').length > 15
}

/**
 * The narrowest type every value fits: boolean (only `true/false/yes/no` words), integer,
 * number, date, else string. Values that look like codes (`007`, card-length digit strings)
 * stay strings so nothing is lost.
 */
export function inferType(values: string[]): FieldType {
  const present = values.map(value => value.trim()).filter(value => value !== '')
  if (present.length === 0)
    return 'string'
  if (present.every(value => /^(?:true|false|yes|no)$/i.test(value)))
    return 'boolean'
  if (!present.some(looksLikeCode)) {
    if (present.every(value => coerce(value, 'integer') !== null))
      return 'integer'
    if (present.every(value => coerce(value, 'number') !== null))
      return 'number'
  }
  if (present.every(value => parseDate(value) !== null))
    return 'date'
  return 'string'
}
