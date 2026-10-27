/**
 * Wrapper induction for pages that list records: table rows or repeated sibling structures (card
 * grids, result lists). Positions inside a record that hold different values across records and
 * samples are fields; positions with one value everywhere are template ("Add to cart").
 */
import type { ExtractField, FieldType, HtmlExtractSpec } from '@site-to-api/runtime'
import type { Document, Element } from './dom'
import type { ExtractedValue } from './values'
import { isTag } from 'domhandler'
import { readRaw } from './apply'
import { attr, childElements, contentElements, cssIdent, cssString, nthChild, nthOfType, ownText, parentElement, select, selectFirst, text } from './dom'
import { typeField } from './fields'
import { NameAllocator } from './naming'
import { capture, escapeRegex } from './pattern'
import { stableClasses, uniqueSelector } from './selector'
import { coerce } from './values'

/** An inferred spec together with the values it is expected to extract, for verification. */
export interface Draft {
  spec: HtmlExtractSpec
  /** Per field, the coerced value of every record of every sample, in document order. */
  expected: Record<string, Array<ExtractedValue | null>>
}

interface Group {
  selector: string
  kind: 'table' | 'repeated'
  /** Header text by `:nth-child` position of the cell. */
  headers: Map<number, string>
}

interface Entry {
  attr: string | null
  /** The element holding the point in each record that has it, by record index. */
  byRecord: Map<number, Element>
  first: Element
  firstRecord: Element
}

/** Children that never form records of their own. */
const NOT_RECORDS = new Set([
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'option',
  'br',
  'hr',
  'col',
  'colgroup',
  'script',
  'style',
  'link',
  'meta',
  'head',
  'source',
  'track',
  'wbr',
])

/** Keeps a pathological page from producing thousands of candidate fields. */
const MAX_POINTS_PER_RECORD = 60

function dataAttributes(element: Element): string[] {
  const names = Object.keys(element.attribs).filter(name => name.startsWith('data-') && /^[\w-]+$/.test(name))
  const own: Record<string, string> = {
    a: 'href',
    img: 'src',
    time: 'datetime',
    input: 'value',
    meta: 'content',
  }
  const extra = own[element.name]
  if (extra !== undefined && attr(element, extra) !== null)
    names.unshift(extra)
  return names
}

function signature(element: Element): string {
  return [
    element.name,
    ...stableClasses(element).sort(),
  ].join('.')
}

/** Path of tag+class steps from the record down, indexed only where siblings share a step. */
function structuralKey(record: Element, element: Element): string {
  const steps: string[] = []
  for (let current: Element | null = element; current && current !== record; current = parentElement(current)) {
    const sig = signature(current)
    const parent = current.parent
    const same = parent
      ? childElements(parent).filter(sibling => signature(sibling) === sig)
      : [current]
    steps.unshift(same.length > 1
      ? `${sig}[${same.indexOf(current) + 1}]`
      : sig)
  }
  return steps.join('/')
}

function headerMap(table: Element): Map<number, string> {
  const headers = new Map<number, string>()
  const row = select('thead tr', table)[0]
    ?? select('tr', table).find(tr => childElements(tr).length > 0 && childElements(tr).every(cell => cell.name === 'th'))
  for (const cell of row
    ? childElements(row)
    : [])
    headers.set(nthChild(cell), text(cell))
  return headers
}

/** `<tr><th>Label</th><td>value</td></tr>` rows describe one item, not a list of records. */
function isKeyValueTable(table: Element): boolean {
  const rows = select('tr', table)
  return rows.length > 0 && rows.every((row) => {
    const cells = childElements(row)
    return cells.length === 2 && (cells[0]?.name === 'th' || text(cells[0] ?? row).endsWith(':'))
  })
}

function tableGroups(samples: Document[]): Group[] {
  const [first] = samples
  if (!first)
    return []
  const groups: Group[] = []
  for (const table of contentElements(first).filter(element => element.name === 'table')) {
    if (isKeyValueTable(table) || select('tr', table).every(row => !childElements(row).some(cell => cell.name === 'td')))
      continue
    const tableSelector = uniqueSelector(table, first, candidate => samples.every(sample => select(candidate, sample).length === 1))
    if (tableSelector === null)
      continue
    const selector = `${tableSelector} tr:has(> td)`
    if (samples.every(sample => select(selector, sample).length > 0)) {
      groups.push({
        selector,
        kind: 'table',
        headers: headerMap(table),
      })
    }
  }
  return groups
}

function repeatedGroups(samples: Document[]): Group[] {
  const [first] = samples
  if (!first)
    return []
  const groups = new Map<string, Group>()
  for (const parent of contentElements(first)) {
    const bySignature = new Map<string, Element[]>()
    for (const child of childElements(parent).filter(element => !NOT_RECORDS.has(element.name))) {
      bySignature.set(signature(child), [
        ...bySignature.get(signature(child)) ?? [],
        child,
      ])
    }
    for (const [sig, members] of bySignature) {
      if (members.length < 2)
        continue
      const parentSelector = uniqueSelector(parent, first, candidate => samples.every(sample => select(candidate, sample).length === 1))
      if (parentSelector === null)
        break
      const [tag, ...names] = sig.split('.')
      const selector = `${parentSelector} > ${tag}${names.map(name => `.${cssIdent(name)}`).join('')}`
      if (samples.every(sample => select(selector, sample).length > 0)) {
        groups.set(selector, {
          selector,
          kind: 'repeated',
          headers: new Map(),
        })
      }
    }
  }
  return [
    ...groups.values(),
  ]
}

function collectEntries(records: Element[]): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  records.forEach((record, index) => {
    let points = 0
    for (const element of [
      record,
      ...contentElements(record),
    ]) {
      const attrs: Array<string | null> = ownText(element) === ''
        ? []
        : [null]
      attrs.push(...dataAttributes(element))
      for (const attrName of attrs) {
        if (++points > MAX_POINTS_PER_RECORD)
          return
        const key = `${structuralKey(record, element)}|${attrName ?? '#text'}`
        const entry = entries.get(key) ?? {
          attr: attrName,
          byRecord: new Map(),
          first: element,
          firstRecord: record,
        }
        entry.byRecord.set(index, element)
        entries.set(key, entry)
      }
    }
  })
  return entries
}

function relativePath(record: Element, element: Element): string {
  const steps: string[] = []
  for (let current: Element | null = element; current && current !== record; current = parentElement(current))
    steps.unshift(`${current.name}:nth-of-type(${nthOfType(current)})`)
  return `:scope > ${steps.join(' > ')}`
}

/** A selector, relative to the record, that finds the entry's element in every record that has it. */
function chooseSelector(entry: Entry, records: Element[]): string | null {
  if (entry.first === entry.firstRecord)
    return ''
  const element = entry.first
  const itemprop = attr(element, 'itemprop')
  const candidates = [
    ...stableClasses(element).map(name => `${element.name}.${cssIdent(name)}`),
    ...(itemprop
      ? [`[itemprop=${cssString(itemprop)}]`]
      : []),
    element.name,
    relativePath(entry.firstRecord, element),
  ]
  const fits = (candidate: string, strict: boolean): boolean => records.every((record, index) => {
    const expected = entry.byRecord.get(index) ?? null
    const found = selectFirst(candidate, record)
    return found === expected || (!strict && expected === null)
  })
  return candidates.find(candidate => fits(candidate, true)) ?? candidates.find(candidate => fits(candidate, false)) ?? null
}

/** Class name without the record's own prefix: `card-title` in `.card` → `title`, BEM `__price` → `price`. */
function cleanClass(name: string, recordClasses: string[]): string {
  const bem = name.split('__').at(-1) ?? name
  const prefix = recordClasses.find(recordClass => bem.startsWith(`${recordClass}-`) || bem.startsWith(`${recordClass}_`))
  return prefix === undefined
    ? bem
    : bem.slice(prefix.length + 1)
}

function textHint(element: Element, record: Element): string | null {
  const itemprop = attr(element, 'itemprop') ?? attr(element, 'aria-label')
  if (itemprop)
    return itemprop
  const previous = element.prev && isTag(element.prev)
    ? text(element.prev)
    : ''
  if (previous.endsWith(':') && previous.length <= 40)
    return previous
  const recordClasses = stableClasses(record)
  for (let current: Element | null = element; current && current !== record; current = parentElement(current)) {
    const name = stableClasses(current)[0]
    if (name !== undefined)
      return cleanClass(name, recordClasses)
  }
  return /^h[1-6]$/.test(element.name)
    ? 'title'
    : null
}

function hintFor(entry: Entry, group: Group): string | null {
  const element = entry.first
  if (entry.attr?.startsWith('data-'))
    return entry.attr.slice(5)
  let base: string | null
  if (group.kind === 'table') {
    let cell: Element = element
    while (parentElement(cell) && parentElement(cell) !== entry.firstRecord)
      cell = parentElement(cell) ?? cell
    base = group.headers.get(nthChild(cell)) ?? null
  }
  else {
    base = textHint(element, entry.firstRecord)
  }
  if (entry.attr === 'src') {
    return base === null || /image|img|photo|picture|thumb/i.test(base)
      ? base ?? 'image'
      : `${base} image`
  }
  if (entry.attr === 'href') {
    return base === null || /url|link|href/i.test(base)
      ? base ?? 'url'
      : `${base} url`
  }
  return base ?? entry.attr
}

interface RawField {
  hint: string | null
  selector: string
  attr: string | null
  /** Pattern the raw values were already cut with (ids taken from links). */
  pattern: string | null
  raw: Array<string | null>
}

function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? ''
  for (const value of values) {
    while (!value.startsWith(prefix))
      prefix = prefix.slice(0, -1)
  }
  return prefix
}

/** `/products/1001-blue-kettle` → an `id` field with pattern `^/products/(\d+)`. */
function idFromLinks(field: RawField): RawField | null {
  const links = field.raw.filter((value): value is string => value !== null)
  if (links.length < 2 || new Set(links).size !== links.length)
    return null
  const shared = commonPrefix(links)
  const cut = Math.max(shared.lastIndexOf('/'), shared.lastIndexOf('='))
  if (cut === -1)
    return null
  const prefix = shared.slice(0, cut + 1)
  const rests = links.map(link => link.slice(prefix.length))
  const core = rests.every(rest => /^\d+/.test(rest))
    ? '(\\d+)'
    : rests.every(rest => /^[\w-]{1,64}$/.test(rest))
      ? '([\\w-]+)'
      : null
  if (core === null)
    return null
  const pattern = `^${escapeRegex(prefix)}${core}`
  return {
    hint: field.hint === null
      ? 'id'
      : field.hint.replace(/\s*url$/i, ' id'),
    selector: field.selector,
    attr: field.attr,
    pattern,
    raw: field.raw.map(value => value === null
      ? null
      : capture(pattern, value)),
  }
}

/**
 * Template text: one value everywhere (unless a lone table sample has nothing to compare), or,
 * with several samples, the same values in the same order in every sample (navigation menus).
 */
function isTemplate(raw: Array<string | null>, sampleOf: number[], group: Group): boolean {
  const sampleCount = new Set(sampleOf).size
  const present = raw.filter((value): value is string => value !== null && value !== '')
  if (present.length === 0 || (new Set(present).size <= 1 && (sampleCount > 1 || group.kind === 'repeated')))
    return true
  if (sampleCount < 2)
    return false
  const perSample = new Map<number, Array<string | null>>()
  raw.forEach((value, index) => {
    const sample = sampleOf[index] ?? 0
    perSample.set(sample, [
      ...perSample.get(sample) ?? [],
      value,
    ])
  })
  return new Set([
    ...perSample.values(),
  ].map(values => JSON.stringify(values))).size === 1
}

function rawFields(group: Group, records: Element[], sampleOf: number[]): RawField[] {
  const fields: RawField[] = []
  for (const entry of collectEntries(records).values()) {
    const selector = chooseSelector(entry, records)
    if (selector === null)
      continue
    const raw = records.map(record => readRaw(record, selector, entry.attr, null))
    if (isTemplate(raw, sampleOf, group))
      continue
    const field = {
      hint: hintFor(entry, group),
      selector,
      attr: entry.attr,
      pattern: null,
      raw,
    }
    fields.push(field)
    const id = entry.attr === 'href'
      ? idFromLinks(field)
      : null
    if (id)
      fields.push(id)
  }
  return fields
}

function toDraft(group: Group, records: Element[], sampleOf: number[]): Draft | null {
  const names = new NameAllocator()
  const fields: Record<string, ExtractField> = {}
  const expected: Record<string, Array<ExtractedValue | null>> = {}
  const seen = new Set<string>()
  for (const raw of rawFields(group, records, sampleOf)) {
    const typed = typeField(raw.raw.filter((value): value is string => value !== null))
    const values = raw.raw.map(value => value === null
      ? null
      : coerceWith(value, typed.pattern, typed.type))
    const key = JSON.stringify(values)
    // A parent and its only child often read the same text; keep the first (outer) one.
    if (seen.has(key) || values.every(value => value === null))
      continue
    seen.add(key)
    const name = names.take(raw.hint)
    fields[name] = {
      selector: raw.selector,
      attr: raw.attr,
      pattern: raw.pattern ?? typed.pattern,
      type: typed.type,
      optional: values.includes(null),
    }
    expected[name] = values
  }
  if (Object.keys(fields).length === 0)
    return null
  return {
    spec: {
      kind: 'html',
      records: group.selector,
      many: true,
      fields,
    },
    expected,
  }
}

function coerceWith(value: string, pattern: string | null, type: FieldType): ExtractedValue | null {
  const core = pattern === null
    ? value
    : capture(pattern, value)
  return core === null
    ? null
    : coerce(core, type)
}

/** Records of every sample in document order, with the sample each came from. */
function recordsOf(group: Group, samples: Document[]): { records: Element[], sampleOf: number[] } {
  const perSample = samples.map(sample => select(group.selector, sample))
  return {
    records: perSample.flat(),
    sampleOf: perSample.flatMap((records, sample) => records.map(() => sample)),
  }
}

/**
 * The best record structure in the samples, as a `many: true` spec. Tables are always
 * considered; repeated sibling structures only with `allowRepeated` (two or more samples, so
 * template and data can be told apart). `null` when no structure yields a field.
 */
export function inferRecords(samples: Document[], allowRepeated: boolean): Draft | null {
  const groups = [
    ...tableGroups(samples),
    ...(allowRepeated
      ? repeatedGroups(samples)
      : []),
  ]
  let best: { draft: Draft, score: number } | null = null
  for (const group of groups) {
    const { records, sampleOf } = recordsOf(group, samples)
    if (group.kind === 'repeated' && records.length < 2 * Math.max(1, samples.length - 1))
      continue
    const draft = toDraft(group, records, sampleOf)
    if (!draft)
      continue
    const fieldCount = Object.keys(draft.spec.fields).length
    if (group.kind === 'repeated' && fieldCount < 2)
      continue
    const score = fieldCount * 100 + records.length / samples.length
    if (!best || score > best.score)
      best = { draft, score }
  }
  return best?.draft ?? null
}
