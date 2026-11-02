/**
 * Wrapper induction for pages that list records: table rows, repeated sibling structures (card
 * grids, result lists) and records spread over several sibling elements (a Hacker News story is
 * a `tr.athing` row plus the row after it). Positions inside a record that hold different values
 * across records and samples are fields; positions with one value everywhere are template
 * ("Add to cart").
 */
import type { ExtractField, FieldType, HtmlExtractSpec } from 'site-to-api-runtime'
import type { Document, Element } from './dom'
import type { Group } from './groups'
import type { Hints, RawField } from './keys'
import type { ExtractedValue } from './values'
import { isTag } from 'domhandler'
import { readRaw } from './apply'
import { attr, childElements, contentElements, cssIdent, cssString, holdsText, nthChild, nthOfType, ownText, parentElement, select, selectFirst, tagSelector, text } from './dom'
import { typeField } from './fields'
import { partsOf, repeatedGroups, signature, spanningGroups, tableGroups } from './groups'
import { classHint, linkWord, recordKind } from './hints'
import { commonPrefix, idFromLinks, idFromRecordIds, isDerived } from './keys'
import { NameAllocator, plural } from './naming'
import { capture } from './pattern'
import { stableClasses } from './selector'
import { coerce } from './values'

/** An inferred spec together with the values it is expected to extract, for verification. */
export interface Draft {
  spec: HtmlExtractSpec
  /** Per field, the coerced value of every record of every sample, in document order. */
  expected: Record<string, Array<ExtractedValue | null>>
  /**
   * Selectors, relative to each record element, of the sibling elements that belong to the same
   * record (`:scope + tr:not(.athing)`). Empty or absent when a record is one element.
   */
  companions?: string[]
}

interface Entry {
  /** 0 for the record element, `n` for its `n`th companion sibling. */
  part: number
  attr: string | null
  /** The element holding the point in each record that has it, by record index. */
  byRecord: Map<number, Element>
  first: Element
  /** The part (record element or companion) that holds `first`. */
  firstRoot: Element
}

/** Keeps a pathological page from producing thousands of candidate fields. */
const MAX_POINTS_PER_RECORD = 120

/** Attributes read as fields: data, links, images, machine-readable times and values. */
function readableAttributes(element: Element, isRecord: boolean): string[] {
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
  // A tooltip holding the exact time behind `3 hours ago`; kept only when it reads as a date.
  if (attr(element, 'title') !== null)
    names.push('title')
  // The record element's own id is often the record's key (`<tr id="50275375">`).
  if (isRecord && attr(element, 'id') !== null)
    names.unshift('id')
  return names
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

/**
 * Where a point sits relative to its nearest ancestor with a stable class: `span.age>a`. Rows
 * of one list differ in layout (a job ad has no score before its age), and points with the same
 * classed position are the same field. `null` when nothing up to the record has a class.
 */
function classedKey(root: Element, element: Element): string | null {
  const tags: string[] = []
  for (let current: Element | null = element; current && current !== root; current = parentElement(current)) {
    // The first class names the thing; later ones are often states (`commtext c5a` when faded).
    const named = firstClass(current)
    if (named !== null)
      return [named, ...tags].join('>')
    tags.unshift(tagSelector(current))
  }
  return null
}

/** Tags that format running text: inside a block of prose they are part of it, not fields. */
const PROSE_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'em',
  'font',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  'small',
  'strong',
  'sub',
  'sup',
  'u',
  'ul',
])

/** A block of prose (a comment, a description): long own text, only formatting inside. */
function isProse(element: Element): boolean {
  const inner = contentElements(element)
  return inner.length > 0 && ownText(element).length >= 40 && inner.every(child => PROSE_TAGS.has(child.name))
}

/** Joins entries that sit at the same classed position and never meet in one record. */
function mergeEntries(entries: Map<string, Entry>): Map<string, Entry> {
  const merged = new Map<string, Entry>()
  const byClassed = new Map<string, Entry>()
  for (const [key, entry] of entries) {
    const classed = classedKey(entry.firstRoot, entry.first)
    const group = classed === null
      ? null
      : `${entry.part}|${classed}|${entry.attr ?? '#text'}`
    const into = group === null
      ? undefined
      : byClassed.get(group)
    if (into && [
      ...entry.byRecord.keys(),
    ].every(index => !into.byRecord.has(index))) {
      for (const [index, element] of entry.byRecord)
        into.byRecord.set(index, element)
      continue
    }
    if (group !== null && !into)
      byClassed.set(group, entry)
    merged.set(key, entry)
  }
  return merged
}

interface Point {
  element: Element
  attr: string | null
}

/**
 * The points of one part in document order: an element's text when it holds some, then its
 * readable attributes. Formatting inside a block of prose belongs to the prose.
 */
function pointsOf(root: Element, isRecord: boolean): Point[] {
  const points: Point[] = []
  const inProse = new Set<Element>()
  for (const element of [
    root,
    ...contentElements(root),
  ]) {
    if (inProse.has(element))
      continue
    if (element !== root && isProse(element)) {
      for (const child of contentElements(element))
        inProse.add(child)
    }
    if (holdsText(element))
      points.push({ element, attr: null })
    for (const name of readableAttributes(element, isRecord && element === root))
      points.push({ element, attr: name })
  }
  return points
}

function collectEntries(parts: Array<Array<Element | null>>): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  parts.forEach((recordParts, index) => {
    const points = recordParts
      .flatMap((root, part) => root
        ? pointsOf(root, part === 0).map(point => ({ ...point, root, part }))
        : [])
      .slice(0, MAX_POINTS_PER_RECORD)
    for (const { element, attr: attrName, root, part } of points) {
      const key = `${part}|${structuralKey(root, element)}|${attrName ?? '#text'}`
      const entry = entries.get(key) ?? {
        part,
        attr: attrName,
        byRecord: new Map(),
        first: element,
        firstRoot: root,
      }
      entry.byRecord.set(index, element)
      entries.set(key, entry)
    }
  })
  return mergeEntries(entries)
}

function relativePath(record: Element, element: Element): string {
  const steps: string[] = []
  for (let current: Element | null = element; current && current !== record; current = parentElement(current))
    steps.unshift(`${tagSelector(current)}:nth-of-type(${nthOfType(current)})`)
  return `:scope > ${steps.join(' > ')}`
}

/**
 * A selector, relative to the record element, that finds the entry's element in every record
 * that has it. Points in a companion are reached through the companion's selector.
 */
function chooseSelector(entry: Entry, records: Element[], companions: string[]): string | null {
  const prefix = entry.part === 0
    ? ''
    : companions[entry.part - 1] ?? null
  if (prefix === null)
    return null
  if (entry.first === entry.firstRoot)
    return prefix
  const element = entry.first
  const itemprop = attr(element, 'itemprop')
  const candidates = [
    ...stableClasses(element).map(name => `${tagSelector(element)}.${cssIdent(name)}`),
    ...(itemprop
      ? [`[itemprop=${cssString(itemprop)}]`]
      : []),
    tagSelector(element),
    ...classedPath(entry.firstRoot, element),
    relativePath(entry.firstRoot, element),
  ].map((candidate) => {
    if (prefix === '')
      return candidate
    return candidate.startsWith(':scope')
      ? `${prefix}${candidate.slice(':scope'.length)}`
      : `${prefix} ${candidate}`
  })
  // Records without the point must find nothing, or the same kind of element (a comment whose
  // text is all inside a link): a selector that reads another element would mix two fields.
  const kind = firstClass(element)
  return candidates.find(candidate => records.every((record, index) => {
    const expected = entry.byRecord.get(index) ?? null
    const found = selectFirst(candidate, record)
    return found === expected || (expected === null && kind !== null && found !== null && firstClass(found) === kind)
  })) ?? null
}

/** `div.commtext` for `<div class="commtext c00">`, or `null` without a stable class. */
function firstClass(element: Element): string | null {
  const [name] = stableClasses(element)
  return name === undefined
    ? null
    : `${element.name}.${name}`
}

/** `span.age > a`: the point under its nearest ancestor with a stable class, if any. */
function classedPath(root: Element, element: Element): string[] {
  const tags = [
    tagSelector(element),
  ]
  for (let current: Element | null = parentElement(element); current && current !== root; current = parentElement(current)) {
    const names = stableClasses(current)
    if (names.length > 0) {
      const tag = tagSelector(current)
      return names.map(name => `${tag}.${cssIdent(name)} > ${tags.join(' > ')}`)
    }
    tags.unshift(tagSelector(current))
  }
  return []
}

function isHeading(element: Element): boolean {
  return /^h[1-6]$/.test(element.name)
}

/** The noun the point's links point at, from the part all records share. */
function sharedLinkWord(entry: Entry): string | null {
  if (entry.first.name !== 'a')
    return null
  const links = [
    ...entry.byRecord.values(),
  ].map(link => attr(link, 'href')).filter((href): href is string => href !== null)
  return links.length < 2
    ? null
    : linkWord(commonPrefix(links))
}

/**
 * Hints from the markup around a point. Strong: a heading, a `Label:` before it, the `itemprop`
 * of the point and of the wrappers that hold exactly its text, the point's own classes. Weak:
 * the wrappers' classes, the noun its link points at, then the classes of other ancestors.
 */
function markupHints(entry: Entry, recordClasses: string[]): Hints {
  const element = entry.first
  const link = sharedLinkWord(entry)
  const own = text(element)
  const chain: Element[] = []
  for (let current: Element | null = element; current && current !== entry.firstRoot; current = parentElement(current))
    chain.push(current)
  const wrappers = chain.filter(current => current === element || text(current) === own)
  const strong: string[] = []
  if (wrappers.some(isHeading))
    strong.push('title')
  const previous = element.prev && isTag(element.prev)
    ? text(element.prev)
    : ''
  if (previous.endsWith(':') && previous.length <= 40)
    strong.push(previous)
  const classHints = (current: Element): string[] => stableClasses(current)
    .map(name => classHint(name, recordClasses, link))
    .filter((hint): hint is string => hint !== null)
  for (const current of wrappers) {
    const itemprop = attr(current, 'itemprop')
    if (itemprop)
      strong.push(itemprop)
  }
  strong.push(...classHints(element))
  // Wrappers' classes come after a counted noun (`4.1 out of 5 stars` is a rating whatever
  // the popover around it is called).
  const weak = [
    ...wrappers.filter(current => current !== element).flatMap(classHints),
    ...(link === null
      ? []
      : [link]),
    ...chain.filter(current => !wrappers.includes(current)).flatMap(classHints),
    // Minified classes (`p` for price) still beat a position.
    ...wrappers.flatMap(current => stableClasses(current).filter(name => /^[a-z]{1,2}$/i.test(name))),
  ]
  return { strong, weak }
}

function tableHeader(entry: Entry, group: Group): string | null {
  if (group.kind !== 'table')
    return null
  let cell: Element = entry.first
  while (parentElement(cell) && parentElement(cell) !== entry.firstRoot)
    cell = parentElement(cell) ?? cell
  return group.headers.get(nthChild(cell)) ?? null
}

/** Hints for an attribute's value from the element's own: `title` → `url`, `price` → `price url`. */
function attributeHints(attrName: string, base: Hints, isDate: boolean): Hints {
  // The plain word (`url`) comes before names taken from wrappers: a link the markup does not
  // name is the record's url, not its `rushComponentUrl`.
  const suffixed = (word: string, already: RegExp, primary: RegExp): Hints => {
    const suffix = (hint: string): string => {
      if (primary.test(hint))
        return word
      return already.test(hint)
        ? hint
        : `${hint} ${word}`
    }
    return {
      strong: [
        ...base.strong.map(suffix),
        word,
      ],
      weak: base.weak.map(suffix),
    }
  }
  if (attrName === 'href')
    return suffixed('url', /url|link|href/i, /^(?:title|name|headline)$/i)
  if (attrName === 'src')
    return suffixed('image', /image|img|photo|picture|thumb/i, /^(?:image|photo|picture)$/i)
  if (isDate)
    return suffixed('date', /date|time/i, /^$/)
  return {
    strong: [
      ...base.strong,
      ...base.weak,
      attrName,
    ],
    weak: [],
  }
}

/** Text that is template: one value everywhere (unless a lone table sample has nothing to compare). */
function isConstant(raw: Array<string | null>, sampleOf: number[], group: Group): boolean {
  const present = raw.filter((value): value is string => value !== null && value !== '')
  return present.length === 0 || (new Set(present).size <= 1 && (new Set(sampleOf).size > 1 || group.kind !== 'table'))
}

/** The same values in the same order in every one of several samples. */
function repeatsEverySample(raw: Array<string | null>, sampleOf: number[]): boolean {
  if (new Set(sampleOf).size < 2)
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

function hintsFor(entry: Entry, group: Group, recordClasses: string[], isDate: boolean): Hints {
  if (entry.attr?.startsWith('data-')) {
    return {
      strong: [
        entry.attr.slice(5),
      ],
      weak: [],
    }
  }
  const header = tableHeader(entry, group)
  const markup = markupHints(entry, recordClasses)
  const base: Hints = {
    strong: [
      ...(header === null
        ? []
        : [header]),
      ...markup.strong,
    ],
    weak: markup.weak,
  }
  return entry.attr === null
    ? base
    : attributeHints(entry.attr, base, isDate)
}

/** The fields one point gives: none (in-page anchors, tooltips), itself, or itself plus an id. */
function fieldsOf(point: Located, group: Group, records: Element[], sampleOf: number[]): RawField[] {
  const { key, entry, selector, raw } = point
  // `#installation` is a jump within the page, not data about the record.
  if (entry.attr === 'href' && raw.every(value => value === null || value.startsWith('#')))
    return []
  const isDate = entry.attr !== null && typeField(raw.filter((value): value is string => value !== null)).type === 'date'
  // Tooltips that are not times repeat or describe the text (`Score of 12`).
  if (entry.attr === 'title' && !isDate)
    return []
  const recordClasses = records[0]
    ? stableClasses(records[0])
    : []
  const field: RawField = {
    hints: hintsFor(entry, group, recordClasses, isDate),
    selector,
    attr: entry.attr,
    pattern: null,
    raw,
    source: key,
    shown: text(entry.first) !== '',
  }
  if (entry.attr === 'id' && selector === '') {
    const id = idFromRecordIds(field, sampleOf)
    return id
      ? [id]
      : []
  }
  const id = entry.attr === 'href'
    ? idFromLinks(field, sampleOf)
    : null
  return id
    ? [field, id]
    : [field]
}

/** A point with the selector that finds it and the text it reads in every record. */
interface Located {
  key: string
  entry: Entry
  selector: string
  raw: Array<string | null>
}

/**
 * Fields of the records. Text that reads the same in the same order in every sample is a menu,
 * unless something else in the records changed: then the samples are one list fetched twice
 * (the same questions, with new view counts) and unchanged titles are still data.
 */
function rawFields(group: Group, records: Element[], sampleOf: number[]): RawField[] {
  const parts = records.map(record => partsOf(record, group.companions))
  const located: Located[] = []
  for (const [key, entry] of collectEntries(parts)) {
    const selector = chooseSelector(entry, records, group.companions)
    if (selector === null)
      continue
    const raw = records.map(record => readRaw(record, selector, entry.attr, null))
    if (!isConstant(raw, sampleOf, group))
      located.push({ key, entry, selector, raw })
  }
  const changed = located.some(point => !repeatsEverySample(point.raw, sampleOf))
  return located
    .filter(point => changed || !repeatsEverySample(point.raw, sampleOf))
    .flatMap(point => fieldsOf(point, group, records, sampleOf))
}

interface TypedRaw {
  raw: RawField
  type: FieldType
  pattern: string | null
  unit: string | null
  values: Array<ExtractedValue | null>
}

function toDraft(group: Group, records: Element[], sampleOf: number[]): Draft | null {
  const typedFields: TypedRaw[] = []
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
    typedFields.push({
      raw,
      type: typed.type,
      pattern: typed.pattern,
      unit: typed.unit ?? null,
      values,
    })
  }
  // The record's main link (the first one that shows text) stays even when it is built from
  // the id: it is how a client opens the record.
  const main = typedFields.find(field => field.raw.attr === 'href' && field.raw.shown)
  // …unless it is built from its own text (`user?id=bob` on `bob`).
  const ownText = main && typedFields.find(field => field.raw.attr === null && field.raw.source === main.raw.source.replace(/\|href$/, '|#text'))
  const exempt = main && !(ownText && isDerived(main.values, ownText.values, sampleOf))
    ? main
    : undefined
  const kept = typedFields.filter(field => field.raw.attr !== 'href' || field === exempt || !typedFields.some(other => other.raw.attr !== 'href'
    && other.raw.source !== field.raw.source
    && isDerived(field.values, other.values, sampleOf)))
  const names = new NameAllocator()
  const fields: Record<string, ExtractField> = {}
  const expected: Record<string, Array<ExtractedValue | null>> = {}
  for (const field of kept) {
    const name = names.takeFree([
      ...field.raw.hints.strong,
      ...(field.unit === null
        ? []
        : [field.unit]),
      ...field.raw.hints.weak,
    ])
    fields[name] = {
      selector: field.raw.selector,
      attr: field.raw.attr,
      pattern: field.raw.pattern ?? field.pattern,
      type: field.type,
      optional: field.values.includes(null),
    }
    expected[name] = field.values
  }
  if (Object.keys(fields).length === 0)
    return null
  // The first record can be a header row without the classes the others share.
  const named = records.find(record => stableClasses(record).length > 0) ?? records[0]
  const kind = named
    ? recordKind(named, group.container)
    : null
  return {
    spec: {
      kind: 'html',
      records: group.selector,
      many: true,
      ...(kind === null
        ? {}
        : {
            recordsName: plural(kind),
          }),
      fields,
    },
    expected,
    companions: group.companions,
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

/** True when a record sits inside another one: the selector matched a layout, not a list. */
function nests(records: Element[]): boolean {
  const set = new Set(records)
  return records.some((record) => {
    for (let current = parentElement(record); current; current = parentElement(current)) {
      if (set.has(current))
        return true
    }
    return false
  })
}

/** Every element a draft's records cover in a document, companions included. */
export function recordElements(draft: Draft, document: Document): Element[] {
  return select(draft.spec.records, document)
    .flatMap(record => partsOf(record, draft.companions ?? []))
    .filter((element): element is Element => element !== null)
}

/**
 * How well the fields fill the records: a field present in every record counts 1, one present
 * in 80% counts 0.64, and one in half of them or fewer counts nothing, so many sparse fields (rows of
 * a layout table, sections of an article, each holding something else) do not outweigh a few
 * that every record has.
 */
function coverage(draft: Draft): number {
  return Object.values(draft.expected).reduce((sum, values) => {
    const share = values.length === 0
      ? 0
      : values.filter(value => value !== null).length / values.length
    return share <= 0.5
      ? sum
      : sum + share * share
  }, 0)
}

/** False for structures that are page layout or a detail page rather than a list of records. */
function looksLikeList(group: Group, records: Element[], sampleOf: number[], samples: Document[]): boolean {
  if (group.kind !== 'table')
    return records.length >= 2 * Math.max(1, samples.length - 1) && !nests(records)
  // One row per page is a detail laid out as a table, not a list.
  if (samples.length > 1 && !samples.some((_, sample) => sampleOf.filter(of => of === sample).length >= 2))
    return false
  // A few rows that each hold a whole table are page layout; many such rows are a list whose
  // entries are laid out with tables, like HN comments.
  const layoutRows = records.length < 5 * samples.length && records.some(record => select('table', record).length > 0)
  return !layoutRows && !nests(records)
}

/**
 * The group's draft and score: how well its fields fill the records, times the evidence of how
 * many records there are (30 stories beat a two-step breadcrumb with as many fields). Table rows
 * are data the page itself marks as tabular, unlike a list in an article's prose.
 */
function scoreGroup(group: Group, samples: Document[]): { draft: Draft, score: number } | null {
  const { records, sampleOf } = recordsOf(group, samples)
  if (!looksLikeList(group, records, sampleOf, samples))
    return null
  const draft = toDraft(group, records, sampleOf)
  if (!draft || (group.kind !== 'table' && Object.keys(draft.spec.fields).length < 2))
    return null
  const tabular = records[0]?.name === 'tr'
    ? 1.5
    : 1
  const score = coverage(draft) * tabular * Math.log2(1 + records.length / samples.length)
  return { draft, score }
}

/**
 * How a selector ranks among others for the same records: plain classes, then marker attributes,
 * then classes with a `__` part. Those are BEM elements or CSS-module hashes in lowercase
 * (`withMetadata__klorrw`), which cannot be told apart and the latter change with each deploy.
 */
function selectorRank(selector: string): number {
  if (/\.[\w-]*__/.test(selector))
    return 2
  return selector.includes('[')
    ? 1
    : 0
}

/**
 * One group per set of records: `div[data-asin]`, `div[data-component-type="s-search-result"]`
 * and `div.s-result-item` often select the same cards, and each would be scored in full. The
 * kept selector is the one a reader expects and a redeploy keeps (see {@link selectorRank}),
 * then the shortest, then the first in code-point order.
 */
export function distinctGroups(groups: Group[], samples: Document[]): Group[] {
  const ids = new Map<Element, number>()
  const id = (element: Element): number => {
    let value = ids.get(element)
    if (value === undefined) {
      value = ids.size
      ids.set(element, value)
    }
    return value
  }
  const preferred = (a: Group, b: Group): number => selectorRank(a.selector) - selectorRank(b.selector)
    || a.selector.length - b.selector.length
    || (a.selector < b.selector
      ? -1
      : Number(a.selector > b.selector))
  const byRecords = new Map<string, Group>()
  for (const group of groups) {
    const key = JSON.stringify([
      group.kind === 'spanning'
        ? group.companions
        : [],
      samples.map(sample => select(group.selector, sample).map(id)),
    ])
    const kept = byRecords.get(key)
    if (!kept || preferred(group, kept) < 0)
      byRecords.set(key, group)
  }
  return [
    ...byRecords.values(),
  ]
}

/**
 * The best record structure in the samples, as a `many: true` spec. Tables and records that
 * span table rows are always considered; other repeated structures only with `allowRepeated`
 * (two or more samples, so template and data can be told apart). Structures are ranked by how
 * well their fields fill the records, so uniform records beat a layout table whose one row
 * holds the whole page. `null` when no structure yields a field.
 */
export function inferRecords(samples: Document[], allowRepeated: boolean): Draft | null {
  const [first] = samples
  const groups = distinctGroups([
    ...spanningGroups(samples).filter(group => allowRepeated || (first && select(group.selector, first)[0]?.name === 'tr')),
    // A table competes with the records spanning its rows: day headings over entries are rows.
    ...tableGroups(samples),
    ...(allowRepeated
      ? repeatedGroups(samples)
      : []),
  ], samples)
  let best: { draft: Draft, score: number } | null = null
  for (const group of groups) {
    const scored = scoreGroup(group, samples)
    if (scored && (!best || scored.score > best.score))
      best = scored
  }
  return best?.draft ?? null
}
