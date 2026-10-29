/**
 * Finds where a value sits in an HTML or text response, so a later request's value can be traced
 * to "the `content` of `meta[name="csrf-token"]`" instead of to an opaque document.
 */
import type { AnyNode } from 'domhandler'
import type { HtmlLocator } from '../../model'
import type { Document, Element } from './dom'
import { allElements, attr, contentElements, looksLikeHtml, parseHtml, select, text } from './dom'
import { anchoredPattern, capture } from './pattern'
import { uniqueSelector } from './selector'

/** Where a value was found; `selector: ''` means the whole document (text responses). */
type HtmlLocation = NonNullable<ReturnType<HtmlLocator>>

/** Attributes in the order a page usually carries data in them. */
function attributePriority(name: string): number {
  if (name === 'value' || name === 'content')
    return 0
  if (name.startsWith('data-'))
    return 1
  return name === 'id' || name === 'class' || name === 'style'
    ? 3
    : 2
}

/** Reads a location back from the document, as extraction will. */
function readLocation(document: Document, location: HtmlLocation): string | null {
  const found = select(location.selector, document)
  const element = found[0]
  if (found.length !== 1 || !element)
    return null
  const raw = location.attr === null
    ? text(element)
    : attr(element, location.attr)
  if (raw === null)
    return null
  return location.pattern === null
    ? raw
    : capture(location.pattern, raw)
}

function locateIn(document: Document, element: Element, value: string, readAttr: string | null, pattern: string | null): HtmlLocation | null {
  const selector = uniqueSelector(element, document, candidate => readLocation(document, { selector: candidate, attr: readAttr, pattern }) === value)
  return selector === null
    ? null
    : { selector, attr: readAttr, pattern }
}

/** Elements that contain the value in their text but have no child element that does too. */
function deepestContaining(elements: Element[], value: string, exact: boolean): Element[] {
  const matches = (element: Element): boolean => exact
    ? text(element) === value
    : text(element).includes(value)
  const hits = elements.filter(matches)
  const hitSet = new Set<AnyNode>(hits)
  return hits.filter(element => !element.children.some(child => hitSet.has(child)))
}

function byAttribute(document: Document, elements: Element[], value: string): HtmlLocation | null {
  const candidates = elements.flatMap(element => Object.entries(element.attribs)
    .filter(([, attrValue]) => attrValue === value)
    .map(([name]) => ({ element, name })))
  candidates.sort((a, b) => attributePriority(a.name) - attributePriority(b.name))
  for (const { element, name } of candidates) {
    const location = locateIn(document, element, value, name, null)
    if (location)
      return location
  }
  return null
}

function byText(document: Document, elements: Element[], value: string, exact: boolean): HtmlLocation | null {
  for (const element of deepestContaining(elements, value, exact)) {
    const content = text(element)
    const pattern = exact
      ? null
      : anchoredPattern(content, content.indexOf(value), value)
    if (!exact && pattern === null)
      continue
    const location = locateIn(document, element, value, null, pattern)
    if (location)
      return location
  }
  return null
}

function byPartialAttribute(document: Document, elements: Element[], value: string): HtmlLocation | null {
  for (const element of elements) {
    for (const [name, attrValue] of Object.entries(element.attribs)) {
      const index = attrValue.indexOf(value)
      if (index === -1 || attrValue === value)
        continue
      const pattern = anchoredPattern(attrValue, index, value)
      const location = pattern === null
        ? null
        : locateIn(document, element, value, name, pattern)
      if (location)
        return location
    }
  }
  return null
}

function locateInText(document: string, value: string): HtmlLocation | null {
  if (document.trim() === value)
    return { selector: '', attr: null, pattern: null }
  const index = document.indexOf(value)
  const pattern = index === -1
    ? null
    : anchoredPattern(document, index, value)
  return pattern === null
    ? null
    : { selector: '', attr: null, pattern }
}

/**
 * Creates the locator. For HTML it tries, in order: an attribute equal to the value (`value`,
 * `content` and `data-*` first), an element whose text is the value, an inline `<script>` that
 * contains it (selector of the script plus a pattern), text that contains it, and finally an
 * attribute that contains it. Each answer is read back from the document before it is returned.
 * Text documents get `selector: ''` (the whole document) and a pattern.
 */
export function createHtmlLocator(onError: (error: unknown) => void = () => {}): HtmlLocator {
  // A page the analysis cannot read (markup it builds an invalid selector from) loses this value
  // origin, not the build.
  const locate: HtmlLocator = (document, value) => {
    if (value.trim() === '' || !document.includes(value.length > 200
      ? value.slice(0, 200)
      : value.split(/[&<>"']/)[0] ?? value)) {
      return null
    }
    if (!looksLikeHtml(document))
      return locateInText(document, value)
    const dom = parseHtml(document)
    const content = contentElements(dom)
    const scripts = allElements(dom).filter(element => element.name === 'script' && attr(element, 'src') === null)
    return byAttribute(dom, allElements(dom), value)
      ?? byText(dom, content, value, true)
      ?? byText(dom, scripts, value, false)
      ?? byText(dom, content, value, false)
      ?? byPartialAttribute(dom, allElements(dom), value)
  }
  return (document, value) => {
    try {
      return locate(document, value)
    }
    catch (error) {
      onError(error)
      return null
    }
  }
}
