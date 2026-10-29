/**
 * Thin, typed wrappers over htmlparser2, domutils and css-select. The runtime's `extract()` uses
 * the same libraries, so a selector verified here behaves the same in a generated client.
 */
import type { AnyNode, Document, Element } from 'domhandler'
import { selectAll, selectOne } from 'css-select'
import { isTag, isText } from 'domhandler'
import { getAttributeValue, textContent } from 'domutils'
import { parseDocument } from 'htmlparser2'

export type { Document, Element }

/** Elements whose text is code, styling or document metadata, never page data. */
const NON_CONTENT = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
])

/** Parses HTML with htmlparser2's defaults (entities decoded, lenient like a browser). */
export function parseHtml(text: string): Document {
  return parseDocument(text)
}

/** True when the text contains markup; plain text and CSV are handled without a DOM. */
export function looksLikeHtml(text: string): boolean {
  return /<(?:!doctype|html|head|body|div|span|table|p|a|ul|ol|li|dl|form|input|meta|script|section|main|article|h[1-6])\b/i.test(text)
}

/** All elements matching a selector under `root` (descendants only, as in the runtime). */
export function select(selector: string, root: AnyNode): Element[] {
  return selectAll<AnyNode, Element>(selector, root)
}

/** First element matching a selector under `root`, or `null`. */
export function selectFirst(selector: string, root: AnyNode): Element | null {
  return selectOne<AnyNode, Element>(selector, root)
}

/** Trimmed text content: what an extraction field with `attr: null` reads. */
export function text(node: AnyNode): string {
  return textContent(node).trim()
}

/** An attribute's value, or `null` when it is absent. */
export function attr(element: Element, name: string): string | null {
  return getAttributeValue(element, name) ?? null
}

/** Child elements in document order. */
export function childElements(node: AnyNode): Element[] {
  return 'children' in node
    ? node.children.filter(isTag)
    : []
}

/** Text of the element's own text nodes, ignoring child elements. */
export function ownText(element: Element): string {
  return element.children.filter(isText).map(child => child.data).join('').trim()
}

/**
 * True when an element's own text is data rather than glue between its children: `points by`
 * … `| hide |` around child elements is glue, and so is `(` … `)` around a link.
 */
export function holdsText(element: Element): boolean {
  const own = ownText(element)
  if (own === '')
    return false
  if (childElements(element).length === 0 || /\d/.test(own))
    return true
  const words = own.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim().split(' ').filter(Boolean)
  return words.length > 2 || words.some(word => word.length > 3)
}

/** Every element under `root` in document order, skipping `<head>`, scripts, styles and templates. */
export function contentElements(root: AnyNode): Element[] {
  const out: Element[] = []
  const visit = (node: AnyNode): void => {
    for (const child of childElements(node)) {
      if (NON_CONTENT.has(child.name))
        continue
      out.push(child)
      visit(child)
    }
  }
  visit(root)
  return out
}

/** Every element under `root`, including scripts. */
export function allElements(root: AnyNode): Element[] {
  const out: Element[] = []
  const visit = (node: AnyNode): void => {
    for (const child of childElements(node)) {
      out.push(child)
      visit(child)
    }
  }
  visit(root)
  return out
}

/** The parent when it is an element (not the document). */
export function parentElement(element: Element): Element | null {
  const parent = element.parent
  return parent && isTag(parent)
    ? parent
    : null
}

/** The element's class names, in source order. */
export function classes(element: Element): string[] {
  return (attr(element, 'class') ?? '').split(/\s+/).filter(Boolean)
}

/** Quotes a value for a CSS attribute selector or `:contains()`. */
export function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, ch => `\\${ch}`).replace(/\n/g, '\\a ')}"`
}

/**
 * Escapes an identifier (tag name, class or id) for a selector, like `CSS.escape`: pages use
 * namespaced tags (`dptags:queryLogOperation`), dots in classes and ids that start with a digit.
 */
export function cssIdent(value: string): string {
  const chars = [...value]
  return chars.map((ch, index) => {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0)
      return '\uFFFD'
    const leadingDigit = /\d/.test(ch) && (index === 0 || (index === 1 && chars[0] === '-'))
    if ((code >= 0x01 && code <= 0x1F) || code === 0x7F || leadingDigit)
      return `\\${code.toString(16)} `
    if (index === 0 && ch === '-' && chars.length === 1)
      return '\\-'
    return code >= 0x80 || /[\w-]/.test(ch)
      ? ch
      : `\\${ch}`
  }).join('')
}

/** The element's tag name as a selector: `dptags\:querylogoperation` for a namespaced tag. */
export function tagSelector(element: Element): string {
  return cssIdent(element.name)
}

/** Position of an element among siblings with the same tag, 1-based (`:nth-of-type`). */
export function nthOfType(element: Element): number {
  const parent = element.parent
  if (!parent)
    return 1
  let index = 0
  for (const sibling of childElements(parent)) {
    if (sibling.name === element.name)
      index++
    if (sibling === element)
      return index
  }
  return index
}

/** Position of an element among all sibling elements, 1-based (`:nth-child`). */
export function nthChild(element: Element): number {
  const parent = element.parent
  return parent
    ? childElements(parent).indexOf(element) + 1
    : 1
}
