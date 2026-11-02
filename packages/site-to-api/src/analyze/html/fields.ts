/**
 * Types and patterns for a field from its sample values: strips currency symbols, units and
 * labels around numbers and dates with a one-group pattern, as `coerce` does not.
 */
import type { FieldType } from 'site-to-api-runtime'
import { capture, escapeRegex, looseLiteral } from './pattern'
import { coerce, inferType } from './values'

/** A field's type and the pattern that isolates the value, if one is needed. */
export interface TypedField {
  type: FieldType
  pattern: string | null
  /** The word counted next to the number (`points` in `12 points`), a hint for the field's name. */
  unit?: string
}

const CORE: Record<FieldType, string> = {
  integer: '([+-]?\\d[\\d,]*)',
  number: '([+-]?\\d[\\d,]*(?:\\.\\d+)?)',
  date: '(\\S(?:[\\s\\S]*\\S)?)',
  boolean: '(\\w+)',
  string: '([\\s\\S]+?)',
}

const NUMBER_TOKEN = /[+-]?\d[\d,]*(?:\.\d+)?/g

/** Words allowed next to a lone number without turning a name like `Pan 3` into a number. */
const UNIT_WORDS = /^(?:rs|inr|usd|eur|gbp|aud|cad|sgd|aed|kg|g|gm|mg|lb|lbs|oz|ml|[lm]|ltr|km|cm|mm|pcs|pc|units?|items?|left|off|only|each|sold|reviews?|ratings?|stars?|votes?|min|mins|hrs?|days?)$/i

function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? ''
  for (const value of values) {
    while (!value.startsWith(prefix))
      prefix = prefix.slice(0, -1)
  }
  return prefix
}

function commonSuffix(values: string[]): string {
  let suffix = values[0] ?? ''
  for (const value of values) {
    while (!value.endsWith(suffix))
      suffix = suffix.slice(1)
  }
  return suffix
}

function verifies(pattern: string, values: string[], type: FieldType): boolean {
  return values.every((value) => {
    const core = capture(pattern, value)
    return core !== null && coerce(core, type) !== null
  })
}

/** Strips a shared prefix/suffix (`₹`, ` / 5`) and types what is left. */
function byAffixes(values: string[]): TypedField | null {
  // The prefix ends before the first digit: `₹1,` shared by `₹1,200` and `₹1,500` is partly data.
  const head = commonPrefix(values).replace(/\d[\s\S]*$/, '')
  // Letters glued to the number (`SKU-1001`, `A12`) make an identifier, not an amount.
  if (/[a-z][-_#/]?$/i.test(head))
    return null
  const prefix = head.replace(/[+.,-]+$/, '')
  const rest = values.map(value => value.slice(prefix.length))
  const suffix = commonSuffix(rest).replace(/^[\d.,]+/, '')
  // `3 hours ago` is a relative time: the next sample says `5 minutes ago`.
  if ((prefix.trim() === '' && suffix.trim() === '') || /\bago\b/i.test(suffix))
    return null
  const cores = rest.map(value => value.slice(0, value.length - suffix.length).trim())
  const type = inferType(cores)
  if (type === 'string' || cores.includes(''))
    return null
  const before = prefix.trim() === ''
    ? ''
    : `${looseLiteral(prefix)}\\s*`
  const after = suffix.trim() === ''
    ? ''
    : `\\s*${looseLiteral(suffix)}`
  const pattern = `${before}${CORE[type]}${after}`
  if (!verifies(pattern, values, type))
    return null
  // `4.1 out of 5 stars` is a rating; `12 votes` counts votes.
  const unit = /^\s*out\s+of\s+\d/i.test(suffix)
    ? 'rating'
    : /^\s*([a-z]{3,})\s*$/i.exec(suffix)?.[1]
  return unit === undefined
    ? { type, pattern }
    : {
        type,
        pattern,
        unit: unit.toLowerCase(),
      }
}

/** `12 points`, `1 point`, and words without a number (`discuss`) for zero. */
const COUNT = /^\s*[+-]?\d[\d,]*\s*([a-z]{3,})\s*$/i

function stem(word: string): string {
  return word.toLowerCase().replace(/s$/, '')
}

/**
 * A count with the same noun after it in every value that has a number, singular or plural
 * (`1 point`, `12 points`). At most half the values may be words without any digit, such as
 * `discuss` where a count of zero would be; they read as `null`.
 */
function byCount(values: string[]): TypedField | null {
  const counted = values.filter(value => /\d/.test(value))
  if (counted.length === 0 || counted.length * 2 < values.length)
    return null
  const words = counted.map(value => COUNT.exec(value)?.[1] ?? null)
  const [first] = words
  if (first === undefined || first === null || words.some(word => word === null || stem(word) !== stem(first)))
    return null
  const noun = stem(first)
  const pattern = `([+-]?\\d[\\d,]*)\\s*${escapeRegex(noun)}s?`
  if (!verifies(pattern, counted, 'integer'))
    return null
  const plural = words.find(word => word !== null && word.toLowerCase() !== noun)
  return {
    type: 'integer',
    pattern,
    unit: (plural ?? `${noun}s`).toLowerCase(),
  }
}

/** One number per value with only currency or unit words around it (`Rs. 50`, `₹ 75 each`). */
function byLoneNumber(values: string[]): TypedField | null {
  const tokens: string[] = []
  for (const value of values) {
    const found = value.match(NUMBER_TOKEN) ?? []
    if (found.length !== 1)
      return null
    const words = value.replace(NUMBER_TOKEN, ' ').match(/[a-z]+/gi) ?? []
    if (!words.every(word => UNIT_WORDS.test(word)))
      return null
    tokens.push(found[0] ?? '')
  }
  const type = inferType(tokens)
  if (type !== 'integer' && type !== 'number')
    return null
  const pattern = CORE.number
  return verifies(pattern, values, type)
    ? { type, pattern }
    : null
}

/** `Seller: Acme Retail` in every value: keep the text after the shared label. */
function byLabel(values: string[]): TypedField | null {
  const prefix = commonPrefix(values)
  const colon = prefix.lastIndexOf(':')
  if (colon < 1 || colon > 40)
    return null
  const label = prefix.slice(0, colon + 1)
  // `https://…`: a URL scheme, not a label.
  if (values.some(value => value.slice(label.length).trim() === '' || value.charAt(label.length) === '/'))
    return null
  return { type: 'string', pattern: `^\\s*${looseLiteral(label)}\\s*${CORE.string}\\s*$` }
}

/**
 * The type for a field and, when the values carry a fixed prefix or suffix around a number or
 * date, a pattern that captures only the value. Values must already be trimmed text.
 */
export function typeField(values: string[]): TypedField {
  const present = values.map(value => value.trim()).filter(value => value !== '')
  const type = inferType(present)
  if (present.length === 0 || type !== 'string')
    return { type, pattern: null }
  return byAffixes(present) ?? byCount(present) ?? byLoneNumber(present) ?? byLabel(present) ?? { type: 'string', pattern: null }
}

/** Pattern that captures what follows a `Label:` and then applies `inner` (or keeps the rest). */
export function afterLabel(label: string, inner: string | null): string {
  return `^\\s*${looseLiteral(label)}\\s*${inner ?? `${CORE.string}\\s*$`}`
}
