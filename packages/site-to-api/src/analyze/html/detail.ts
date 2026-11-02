/**
 * Wrapper induction for pages about one item (`many: false`): label/value layouts (definition
 * lists, two-column tables, `Label:` elements, `Label: value` text) and, with several samples,
 * positions whose text differs between samples.
 */
import type { ExtractField, FieldType } from 'site-to-api-runtime'
import type { Document, Element } from './dom'
import type { Draft } from './records'
import type { ExtractedValue } from './values'
import { readRaw } from './apply'
import { attr, childElements, contentElements, cssString, holdsText, parentElement, select, tagSelector, text } from './dom'
import { afterLabel, typeField } from './fields'
import { classHint, linkWord } from './hints'
import { NameAllocator } from './naming'
import { capture } from './pattern'
import { isStableId, selectorCandidates, stableClasses, uniqueSelector } from './selector'
import { coerce } from './values'

interface Pair {
  label: string
  value: Element
  labelElement: Element | null
  /** Selector built from the label, e.g. `dt:contains("Price") + dd`. */
  selector: string | null
  /** Set when label and value share one text: `Label: value`. */
  inline: boolean
}

/** Longest label we treat as one; longer text before a colon is a sentence. */
const MAX_LABEL = 40
/** Fields longer than this on average are prose, not data. */
const PROSE_CHARS = 160
const PROSE_WORDS = 25
const MAX_POSITIONS = 400
/** Elements whose trailing colon starts a sentence's continuation, not a value. */
const PROSE_LABELS = /^(?:p|li|h[1-6]|blockquote|figcaption)$/

function nextElement(element: Element): Element | null {
  const parent = element.parent
  if (!parent)
    return null
  const siblings = childElements(parent)
  return siblings[siblings.indexOf(element) + 1] ?? null
}

function pairFromSiblings(labelElement: Element, value: Element | null, label: string): Pair | null {
  if (!value || text(value) === '' || label === '' || label.length > MAX_LABEL)
    return null
  return {
    label,
    value,
    labelElement,
    selector: `${tagSelector(labelElement)}:contains(${cssString(label)}) + ${tagSelector(value)}`,
    inline: false,
  }
}

function inlinePair(element: Element): Pair | null {
  if (childElements(element).length > 0)
    return null
  const match = /^([a-z][^:\n]{0,39}):\s*\S[\s\S]{0,160}$/i.exec(text(element))
  return match?.[1]
    ? {
        label: `${match[1]}:`,
        value: element,
        labelElement: null,
        selector: null,
        inline: true,
      }
    : null
}

/** Label/value pairs in document order. */
function labelPairs(document: Document): Pair[] {
  const pairs: Pair[] = []
  const push = (pair: Pair | null): void => {
    if (pair && !pairs.some(other => other.value === pair.value))
      pairs.push(pair)
  }
  for (const dt of select('dt', document))
    push(pairFromSiblings(dt, nextElement(dt), text(dt)))
  for (const row of select('tr', document)) {
    const [head, cell, ...rest] = childElements(row)
    if (head && cell && rest.length === 0 && (head.name === 'th' || text(head).endsWith(':')))
      push(pairFromSiblings(head, cell, text(head)))
  }
  for (const element of contentElements(document)) {
    const label = text(element)
    // A paragraph or heading ending in `:` introduces what follows (`Install it:` before a code
    // block); it labels a value only in a table, a definition list or a short inline label.
    if (childElements(element).length === 0 && label.endsWith(':') && label.length <= MAX_LABEL && !PROSE_LABELS.test(element.name))
      push(pairFromSiblings(element, nextElement(element), label))
    push(inlinePair(element))
  }
  return pairs
}

function uniqueEverywhere(selector: string, samples: Document[]): boolean {
  return samples.every((sample) => {
    try {
      return select(selector, sample).length === 1
    }
    catch {
      return false
    }
  })
}

interface DetailField {
  hint: string
  selector: string
  /** For `Label: value` text, the label the value follows. */
  label: string | null
  /** Trimmed text at the selector in each sample. */
  texts: Array<string | null>
  prose: boolean
}

function pairField(pair: Pair, samples: Document[]): DetailField | null {
  const [first] = samples
  if (!first)
    return null
  const selector = pair.selector !== null && uniqueEverywhere(pair.selector, samples) && select(pair.selector, first)[0] === pair.value
    ? pair.selector
    : uniqueSelector(pair.value, first, candidate => uniqueEverywhere(candidate, samples))
  if (selector === null)
    return null
  const texts = samples.map(sample => readRaw(sample, selector, null, null))
  return {
    hint: pair.label,
    selector,
    label: pair.inline ? pair.label : null,
    texts,
    prose: false,
  }
}

function isProse(values: string[]): boolean {
  if (values.length === 0)
    return false
  const chars = values.reduce((sum, value) => sum + value.length, 0) / values.length
  const words = values.reduce((sum, value) => sum + value.split(/\s+/).length, 0) / values.length
  return chars > PROSE_CHARS || words > PROSE_WORDS
}

function positionHint(element: Element): string | null {
  const id = attr(element, 'id')
  const href = element.name === 'a'
    ? attr(element, 'href')
    : null
  const link = href === null
    ? null
    : linkWord(href.replace(/[^/?=&]*$/, ''))
  for (let current: Element | null = element; current; current = parentElement(current)) {
    const itemprop = attr(current, 'itemprop')
    if (itemprop)
      return itemprop
    const named = stableClasses(current).map(name => classHint(name, [], link)).find(hint => hint !== null)
    if (named !== undefined && named !== null)
      return named
    if (current.name === 'body')
      break
  }
  if (id !== null && isStableId(id))
    return id
  return /^h[1-6]$/.test(element.name)
    ? 'title'
    : null
}

/** Elements whose own text differs between samples at a selector that is unique in all of them. */
function varyingFields(samples: Document[], used: Set<Element>): DetailField[] {
  const [first] = samples
  if (!first)
    return []
  const fields: DetailField[] = []
  const points = contentElements(first).filter(element => holdsText(element) && !used.has(element)).slice(0, MAX_POSITIONS)
  for (const element of points) {
    // The first sample is checked first: most candidates fail there, before every page is searched.
    const selector = selectorCandidates(element, first).find(candidate => select(candidate, first)[0] === element && uniqueEverywhere(candidate, samples))
    if (selector === undefined)
      continue
    const raw = samples.map(sample => readRaw(sample, selector, null, null))
    const present = raw.filter((value): value is string => value !== null && value !== '')
    if (new Set(present).size <= 1)
      continue
    fields.push({
      hint: positionHint(element) ?? '',
      selector,
      label: null,
      texts: raw,
      prose: isProse(present),
    })
  }
  return fields
}

function coerceWith(value: string, pattern: string | null, type: FieldType): ExtractedValue | null {
  const core = pattern === null
    ? value
    : capture(pattern, value)
  return core === null
    ? null
    : coerce(core, type)
}

/** Types a field; a `Label:` prefix becomes part of the pattern so only the value is captured. */
function typed(field: DetailField): { field: ExtractField, values: Array<ExtractedValue | null> } | null {
  const labelOnly = field.label === null
    ? null
    : afterLabel(field.label, null)
  const cores = field.texts
    .map(value => value === null || labelOnly === null
      ? value
      : capture(labelOnly, value))
    .filter((value): value is string => value !== null)
  const inner = typeField(cores)
  const pattern = field.label === null
    ? inner.pattern
    : afterLabel(field.label, inner.pattern)
  const values = field.texts.map(value => value === null
    ? null
    : coerceWith(value, pattern, inner.type))
  if (values.every(value => value === null))
    return null
  return {
    field: {
      selector: field.selector,
      attr: null,
      pattern,
      type: inner.type,
      optional: values.includes(null),
    },
    values,
  }
}

/**
 * A `many: false` spec for a detail page, or `null`. Label/value pairs work from one sample;
 * `allowVarying` (two or more samples) adds positions whose text differs between samples, leaving
 * out long prose such as descriptions. Elements in `exclude` (records found elsewhere) are skipped.
 */
export function inferDetail(samples: Document[], allowVarying: boolean, exclude: ReadonlySet<Element> = new Set()): Draft | null {
  const [first] = samples
  if (!first)
    return null
  const pairs = labelPairs(first).filter(pair => !exclude.has(pair.value))
  const used = new Set<Element>([
    ...exclude,
    ...pairs.flatMap(pair => pair.labelElement
      ? [pair.value, pair.labelElement]
      : [pair.value]),
  ])
  for (const pair of pairs) {
    for (const element of contentElements(pair.value))
      used.add(element)
  }
  const labelled = pairs.map(pair => pairField(pair, samples)).filter((field): field is DetailField => field !== null)
  const varying = allowVarying
    ? varyingFields(samples, used).filter(field => !field.prose)
    : []
  // Without labels, one changing heading over changing paragraphs is an article, not a record.
  const candidates = labelled.length === 0 && varying.length < 2
    ? []
    : [
        ...labelled,
        ...varying,
      ]
  const names = new NameAllocator()
  const fields: Record<string, ExtractField> = {}
  const expected: Record<string, Array<ExtractedValue | null>> = {}
  for (const candidate of candidates) {
    const result = typed(candidate)
    if (!result)
      continue
    const name = names.take(candidate.hint)
    fields[name] = result.field
    expected[name] = result.values
  }
  if (Object.keys(fields).length === 0)
    return null
  return {
    spec: {
      kind: 'html',
      records: ':root',
      many: false,
      fields,
    },
    expected,
  }
}
