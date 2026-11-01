import type { AnyNode, Element } from 'domhandler'
import type { HtmlEngine } from './engine'
import { selectAll, selectOne } from 'css-select'
import { getAttributeValue, textContent } from 'domutils'
import { parseDocument } from 'htmlparser2'

function isElement(node: AnyNode): node is Element {
  return 'attribs' in node
}

/** Extraction on htmlparser2 and css-select: works wherever JavaScript runs. */
export const htmlparser2Engine: HtmlEngine<AnyNode> = {
  parse: html => parseDocument(html),
  selectAll: (selector, root) => selectAll<AnyNode, Element>(selector, root),
  selectOne: (selector, root) => selectOne<AnyNode, Element>(selector, root),
  text: node => textContent(node),
  attribute: (node, name) => isElement(node)
    ? getAttributeValue(node, name) ?? null
    : null,
}
