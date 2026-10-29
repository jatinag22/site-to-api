/**
 * Where a page's records are: rows of a table, siblings that repeat one structure (cards, list
 * items), or a repeated element together with the differently shaped siblings that follow it
 * (a Hacker News story is a `tr.athing` row, the row after it and a spacer). Every group is a
 * selector that finds the same structure in all samples.
 */
import type { Document, Element } from './dom'
import { childElements, contentElements, cssIdent, cssString, nthChild, select, selectFirst, text } from './dom'
import { stableClasses, uniqueSelector } from './selector'

export interface Group {
  selector: string
  /**
   * `table`: rows of a table. `repeated`: siblings with one signature. `spanning`: a repeated
   * element plus the differently shaped siblings that follow it up to the next one.
   */
  kind: 'table' | 'repeated' | 'spanning'
  /** Header text by `:nth-child` position of the cell. */
  headers: Map<number, string>
  /** For `spanning`: selectors, relative to the record element, of its companion siblings. */
  companions: string[]
  /** The element that holds the records (the table, or the common parent). */
  container: Element
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

/** Siblings that never belong to a record that spans several elements. */
const NOT_COMPANIONS = new Set([
  'script',
  'style',
  'link',
  'meta',
  'template',
])

/** A record spread over more siblings than this is a page section, not a record. */
const MAX_COMPANIONS = 3

export function signature(element: Element): string {
  return [
    element.name,
    ...stableClasses(element).sort(),
  ].join('.')
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

/**
 * `<tr><th>Label</th><td>value</td></tr>` rows describe one item, not a list of records. Rows
 * with an empty first cell (links under a profile) do not change that.
 */
function isKeyValueTable(table: Element): boolean {
  const rows = select('tr', table).filter(row => childElements(row).length > 0)
  const labelled = rows.filter((row) => {
    const [head] = childElements(row)
    return head !== undefined && (head.name === 'th' || text(head).endsWith(':'))
  })
  return labelled.length > 0 && rows.every((row) => {
    const cells = childElements(row)
    return cells.length === 2 && (labelled.includes(row) || text(cells[0] ?? row) === '')
  })
}

/**
 * True when the table mixes data rows of several cells with rows of one cell. Such a one-cell row
 * heads the rows below it whether or not it spans columns: `colspan` is optional in practice.
 */
export function hasHeadingRows(table: Element): boolean {
  const rows = select('tr', table).map(row => childElements(row).filter(cell => cell.name === 'td'))
  const heading = rows.filter(cells => cells.length === 1)
  return heading.length > 0 && rows.filter(cells => cells.length >= 2).length > heading.length
}

export function tableGroups(samples: Document[]): Group[] {
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
    // Rows of tables nested inside this one belong to those tables. Rows that are one cell
    // across the table (`<td colspan="3">Day 1</td>`) head the data rows below them.
    const row = hasHeadingRows(table)
      ? 'tr:has(> td + td)'
      : 'tr:has(> td)'
    const selector = select('table', table).length === 0
      ? `${tableSelector} ${row}`
      : `${tableSelector} > ${row}, ${tableSelector} > tbody > ${row}`
    if (samples.every(sample => select(selector, sample).length > 0)) {
      groups.push({
        selector,
        kind: 'table',
        headers: headerMap(table),
        companions: [],
        container: table,
      })
    }
  }
  return groups
}

/** Attributes that never mark what kind of element a sibling is. */
const NOT_MARKERS = /^(?:class|id|style|href|src|srcset|alt|title|tabindex|aria-.+|data-uuid|data-index)$/

/**
 * Compounds that mark siblings as one kind besides their classes: a shared short attribute value
 * (`[data-component-type="s-search-result"]`) or a data attribute every one carries with its
 * own value (`[data-asin]`). Result cards often differ in layout classes between pages and
 * between ads and organic results; these markers do not.
 */
export function markers(element: Element): string[] {
  return Object.entries(element.attribs)
    .filter(([name]) => !NOT_MARKERS.test(name) && /^[a-z][\w-]*$/.test(name))
    .flatMap(([name, value]) => {
      if (/^[a-z][\w-]{0,39}$/i.test(value) && !/\d{3,}/.test(value))
        return [`[${name}=${cssString(value)}]`]
      return name.startsWith('data-')
        ? [`[${name}]`]
        : []
    })
}

function push(map: Map<string, Element[]>, key: string, element: Element): void {
  map.set(key, [
    ...map.get(key) ?? [],
    element,
  ])
}

/** Selector compounds shared by two or more children of `parent`: a class signature or a marker. */
function siblingKinds(parent: Element): string[] {
  const byKind = new Map<string, Element[]>()
  for (const child of childElements(parent).filter(element => !NOT_RECORDS.has(element.name))) {
    const [tag, ...names] = signature(child).split('.')
    push(byKind, `${tag}${names.map(name => `.${cssIdent(name)}`).join('')}`, child)
    for (const marker of markers(child))
      push(byKind, `${child.name}${marker}`, child)
  }
  return [
    ...byKind,
  ].filter(([, members]) => members.length >= 2).map(([kind]) => kind)
}

export function repeatedGroups(samples: Document[]): Group[] {
  const [first] = samples
  if (!first)
    return []
  const groups = new Map<string, Group>()
  for (const parent of contentElements(first)) {
    const kinds = siblingKinds(parent)
    if (kinds.length === 0)
      continue
    const parentSelector = uniqueSelector(parent, first, candidate => samples.every(sample => select(candidate, sample).length === 1))
    if (parentSelector === null)
      continue
    for (const compound of kinds) {
      const selector = `${parentSelector} > ${compound}`
      if (samples.every(sample => select(selector, sample).length > 0)) {
        groups.set(selector, {
          selector,
          kind: 'repeated',
          headers: new Map(),
          companions: [],
          container: parent,
        })
      }
    }
  }
  return [
    ...groups.values(),
  ]
}

/** The child signatures of an element: two rows of one table have the same shape. */
function shape(element: Element): string {
  return childElements(element).map(signature).join(' ')
}

/** Tags of the siblings after each anchor that form one record with it, or `null`. */
function companionTags(children: Element[], indexes: number[], span: number): string[] | null {
  const [firstIndex] = indexes
  const anchor = firstIndex === undefined
    ? undefined
    : children[firstIndex]
  if (anchor === undefined)
    return null
  const tags: string[] = []
  for (let offset = 1; offset <= span; offset++) {
    const at = indexes.map(index => children[index + offset]).filter((element): element is Element => element !== undefined)
    const tag = at[0]?.name
    if (tag === undefined || NOT_COMPANIONS.has(tag) || !at.every(element => element.name === tag))
      break
    // Same shape as the anchor: alternating rows (`tr.odd` / `tr.even`) are records of their own.
    if (at.some(element => shape(element) !== '' && shape(element) === shape(anchor)))
      return null
    tags.push(tag)
  }
  // Companions of one shape at two offsets are repeated rows (entries under a day heading), not
  // the parts of one record.
  const shapes = indexes.flatMap(index => tags.map((_, offset) => {
    const companion = children[index + offset + 1]
    return companion === undefined
      ? ''
      : shape(companion)
  }).filter((value, offset, all) => value !== '' && all.indexOf(value) !== offset))
  if (shapes.length > 0)
    return null
  const hasContent = indexes.some(index => tags.some((_, offset) => {
    const companion = children[index + offset + 1]
    return companion !== undefined && text(companion) !== ''
  }))
  return tags.length > 0 && hasContent
    ? tags
    : null
}

/** True when a sibling more than `span` after an anchor, before the next one, shows text. */
function dropsContent(children: Element[], indexes: number[], span: number): boolean {
  return indexes.slice(0, -1).some((index, position) => {
    const next = indexes[position + 1] ?? index
    return children.slice(index + span + 1, next).some(child => text(child) !== '')
  })
}

/** The spanning group anchored on the children at `indexes` of `parent`, or `null`. */
function spanningGroup(parent: Element, sig: string, indexes: number[], samples: Document[]): Group | null {
  const [first] = samples
  const children = childElements(parent)
  // A spacer row repeats too, but a record starts with content.
  if (!first || indexes.length < 2 || indexes.filter(index => text(children[index] ?? parent) !== '').length * 2 < indexes.length)
    return null
  const gaps = indexes.slice(1).map((index, position) => index - (indexes[position] ?? index))
  const span = Math.min(MAX_COMPANIONS, Math.min(...gaps) - 1)
  // Every sibling between two anchors must belong to a record: a longer gap with content would
  // be dropped (a day heading with a varying number of entries under it).
  if (dropsContent(children, indexes, span))
    return null
  const tags = span < 1
    ? null
    : companionTags(children, indexes, span)
  const parentSelector = tags === null
    ? null
    : uniqueSelector(parent, first, candidate => samples.every(sample => select(candidate, sample).length === 1))
  if (tags === null || parentSelector === null)
    return null
  const [tag, ...names] = sig.split('.')
  const compound = names.map(name => `.${cssIdent(name)}`).join('')
  const selector = `${parentSelector} > ${tag}${compound}`
  if (!samples.every(sample => select(selector, sample).length > 0))
    return null
  return {
    selector,
    kind: 'spanning',
    headers: new Map(),
    companions: tags.map((_, offset) => `:scope${tags.slice(0, offset + 1).map(companion => ` + ${companion}:not(${compound})`).join('')}`),
    container: parent,
  }
}

/**
 * Records that span sibling elements: an element with a stable class that repeats with other
 * siblings between each occurrence (`tr.athing`, then the subtext row, then a spacer). The
 * record is the repeated element plus the siblings before the next one (at most the smallest
 * gap), reached with `:scope + tag` selectors.
 */
export function spanningGroups(samples: Document[]): Group[] {
  const [first] = samples
  if (!first)
    return []
  const groups = new Map<string, Group>()
  for (const parent of contentElements(first)) {
    const children = childElements(parent)
    const bySignature = new Map<string, number[]>()
    children.forEach((child, index) => {
      if (stableClasses(child).length === 0 || NOT_COMPANIONS.has(child.name))
        return
      bySignature.set(signature(child), [
        ...bySignature.get(signature(child)) ?? [],
        index,
      ])
    })
    for (const [sig, indexes] of bySignature) {
      const group = spanningGroup(parent, sig, indexes, samples)
      if (group)
        groups.set(group.selector, group)
    }
  }
  return [
    ...groups.values(),
  ]
}

/** The record element followed by each companion (or `null` where a record lacks it). */
export function partsOf(record: Element, companions: string[]): Array<Element | null> {
  return [
    record,
    ...companions.map(companion => selectFirst(companion, record)),
  ]
}
