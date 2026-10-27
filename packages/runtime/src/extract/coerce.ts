import type { FieldType } from './types'

/** Whitespace, currency symbols and thousands separators that sites put around numbers. */
const NUMBER_NOISE = /[\s,₹$€£%]/g
const BOOLEAN_TRUE = new Set([
  'true',
  'yes',
  'y',
  '1',
  'on',
  '✓',
  '✔',
])
const BOOLEAN_FALSE = new Set([
  'false',
  'no',
  'n',
  '0',
  'off',
  '✗',
  '✘',
])
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

/**
 * Converts extracted text to the field's type. Numbers and booleans that cannot be read become
 * `null`; dates that cannot be read stay as the original text, because a date the parser does not
 * know is still useful to the caller.
 */
export function coerce(raw: string, type: FieldType): string | number | boolean | null {
  switch (type) {
    case 'string':
      return raw
    case 'number':
      return toNumber(raw)
    case 'integer': {
      const value = toNumber(raw)
      return value !== null && Number.isInteger(value)
        ? value
        : null
    }
    case 'boolean': {
      const lower = raw.trim().toLowerCase()
      if (BOOLEAN_TRUE.has(lower))
        return true
      return BOOLEAN_FALSE.has(lower)
        ? false
        : null
    }
    case 'date':
      return toIsoDate(raw) ?? raw
  }
}

function toNumber(raw: string): number | null {
  let text = raw.replace(NUMBER_NOISE, '')
  // Accounting style: (1,234.50) is negative.
  const negative = /^\(.*\)$/.test(text)
  if (negative)
    text = text.slice(1, -1)
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text))
    return null
  const value = Number(text)
  return negative
    ? -value
    : value
}

/**
 * Reads ISO dates and dates with a month name (`12 Mar 2026`, `12-Mar-2026`, `March 12, 2026`)
 * without relying on `Date.parse`, whose leniency differs between runtimes. All-numeric forms
 * such as `03/04/2026` are ambiguous (day or month first) and stay as text.
 */
function toIsoDate(raw: string): string | null {
  const text = raw.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[-+]\d{2}:?\d{2})?)?$/.exec(text)
  if (iso) {
    const [, year, month, day, hour, minute, second, zone] = iso
    if (!validDay(Number(year), Number(month), Number(day)))
      return null
    if (hour === undefined)
      return `${year}-${month}-${day}`
    const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second ?? '00'}${normalizeZone(zone)}`)
    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString()
  }
  const dayFirst = /^(\d{1,2})[\s\-/]+([a-z]{3,9})\.?[\s\-/,]+(\d{4})$/i.exec(text)
  if (dayFirst)
    return fromParts(dayFirst[3], dayFirst[2], dayFirst[1])
  const monthFirst = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(text)
  if (monthFirst)
    return fromParts(monthFirst[3], monthFirst[1], monthFirst[2])
  return null
}

function normalizeZone(zone: string | undefined): string {
  if (zone === undefined || zone === 'Z')
    return 'Z'
  return zone.includes(':')
    ? zone
    : `${zone.slice(0, 3)}:${zone.slice(3)}`
}

function fromParts(year: string | undefined, monthName: string | undefined, day: string | undefined): string | null {
  const month = MONTHS[(monthName ?? '').slice(0, 3).toLowerCase()]
  const y = Number(year)
  const d = Number(day)
  if (month === undefined || !validDay(y, month, d))
    return null
  return `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function validDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1)
    return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}
