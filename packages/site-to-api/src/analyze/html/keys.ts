/**
 * Record keys and links built from them: an id from the record element's own `id` or from its
 * links (`item?id=50275375`), and links that are only fixed text around another field
 * (`vote?id=50275375&how=up`), which a client can build itself.
 */
import type { ExtractedValue } from './values'
import { capture, escapeRegex } from './pattern'

/** Name hints for a point, best first: `strong` ones name it, `weak` ones say where it sits. */
export interface Hints {
  strong: string[]
  weak: string[]
}

export function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? ''
  for (const value of values) {
    while (!value.startsWith(prefix))
      prefix = prefix.slice(0, -1)
  }
  return prefix
}

export interface RawField {
  hints: Hints
  selector: string
  attr: string | null
  /** Pattern the raw values were already cut with (ids taken from links). */
  pattern: string | null
  raw: Array<string | null>
  /** The point the field reads; fields cut from one point never make each other redundant. */
  source: string
  /** True when the point's element shows text (a link with words, not an icon). */
  shown: boolean
}

/** Query parameters that name the record they link to. */
const ID_PARAMETER = /(?:^|[?&])(?:id|key|[a-z]+_?id)=$/i

/**
 * `/products/1001-blue-kettle` or `item?id=1001` → an `id` field with pattern
 * `^/products/(\d+)`. The number must end at a path, query or slug boundary: the `2011` of
 * `front?day=2011-03-11` is part of a date, and a parameter not named like an id (`?p=2`) does
 * not make one.
 */
/**
 * True when no value repeats within one sample. Identical samples (the same page captured
 * twice) repeat every value across samples, which says nothing against a key.
 */
function uniquePerSample(raw: Array<string | null>, sampleOf: number[]): boolean {
  const seen = new Set<string>()
  return raw.every((value, index) => {
    if (value === null)
      return true
    const key = `${sampleOf[index] ?? 0}\u0000${value}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

export function idFromLinks(field: RawField, sampleOf: number[]): RawField | null {
  const links = field.raw.filter((value): value is string => value !== null)
  if (links.length < 2 || new Set(links).size < 2 || !uniquePerSample(field.raw, sampleOf))
    return null
  const shared = commonPrefix(links)
  const cut = Math.max(shared.lastIndexOf('/'), shared.lastIndexOf('='))
  if (cut === -1)
    return null
  const prefix = shared.slice(0, cut + 1)
  if (prefix.endsWith('=') && !ID_PARAMETER.test(prefix))
    return null
  const rests = links.map(link => link.slice(prefix.length))
  const core = rests.every(rest => /^\d+(?:$|[/?#&]|-[a-z])/i.test(rest))
    ? '(\\d+)'
    : rests.every(rest => /^[\w-]{1,64}$/.test(rest))
      ? '([\\w-]+)'
      : null
  if (core === null)
    return null
  const pattern = `^${escapeRegex(prefix)}${core}`
  const named = field.hints.strong
    .filter(hint => /\surl$/i.test(hint))
    .map(hint => hint.replace(/\s*url$/i, ' id'))
  return {
    hints: {
      strong: [...named, 'id'],
      weak: [],
    },
    selector: field.selector,
    attr: field.attr,
    pattern,
    raw: field.raw.map(value => value === null
      ? null
      : capture(pattern, value)),
    source: field.source,
    shown: field.shown,
  }
}

/** True when each sample's numbers are 0, 1, 2, … or 1, 2, 3, …: row positions, not keys. */
function countsRows(numbers: Array<number | null>, sampleOf: number[]): boolean {
  const bySample = new Map<number, number[]>()
  numbers.forEach((value, index) => {
    if (value === null)
      return
    const sample = sampleOf[index] ?? 0
    bySample.set(sample, [
      ...bySample.get(sample) ?? [],
      value,
    ])
  })
  return [
    ...bySample.values(),
  ].every((values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const start = sorted[0] ?? 0
    return start <= 1 && sorted.every((value, index) => value === start + index)
  })
}

/**
 * The record element's `id` as its key: `50275375`, or the number in
 * `question-summary-80013191`. Ids that only count rows (`folder-row-0`, `folder-row-1`) or
 * hold no number say nothing about the record and are left out.
 */
export function idFromRecordIds(field: RawField, sampleOf: number[]): RawField | null {
  const present = field.raw.filter((value): value is string => value !== null)
  if (present.length < 2 || new Set(present).size < 2 || !uniquePerSample(field.raw, sampleOf))
    return null
  const head = commonPrefix(present).replace(/\d+$/, '')
  if (!present.every(value => /^\d+$/.test(value.slice(head.length))))
    return null
  const numbers = field.raw.map(value => value === null
    ? null
    : Number(value.slice(head.length)))
  if (countsRows(numbers, sampleOf))
    return null
  const pattern = head === ''
    ? null
    : `^${escapeRegex(head)}(\\d+)$`
  return {
    hints: {
      strong: ['id'],
      weak: [],
    },
    selector: field.selector,
    attr: field.attr,
    pattern,
    raw: field.raw.map(value => value === null || pattern === null
      ? value
      : capture(pattern, value)),
    source: field.source,
    shown: field.shown,
  }
}

/**
 * True when, within each sample, every value of a link is one fixed text around another
 * field's value (`vote?id=50275375&how=up` around the id, `user?id=bob` around the user): the
 * link adds nothing a client could not build from that field and the page it came from.
 */
export function isDerived(values: Array<ExtractedValue | null>, other: Array<ExtractedValue | null>, sampleOf: number[]): boolean {
  if (new Set(other.filter(value => value !== null)).size < 2)
    return false
  const templates = new Map<number, string>()
  for (const [index, value] of values.entries()) {
    if (value === null)
      continue
    const core = other[index]
    if (core === null || core === undefined || String(core) === '' || !String(value).includes(String(core)))
      return false
    const outline = String(value).split(String(core)).join('\u0000')
    const sample = sampleOf[index] ?? 0
    if ((templates.get(sample) ?? outline) !== outline)
      return false
    templates.set(sample, outline)
  }
  return templates.size > 0
}
