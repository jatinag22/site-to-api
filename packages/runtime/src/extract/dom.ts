import type { HtmlEngine } from './engine'

type DomNode = Document | Element

/** `:contains("text")`, as `site-to-api build` writes it (a CSS string with `\"`, `\\` and `\a ` escapes). */
const CONTAINS = /:contains\(("(?:[^"\\]|\\[\s\S])*")\)/g

function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\a ?|\\([\s\S])/g, (escape, char: string | undefined) => char ?? '\n')
}

function rootElement(node: DomNode): Element | null {
  return node instanceof Element
    ? node
    : node.documentElement
}

/**
 * Native selectors have no `:contains()`, which css-select has and `build` uses for label rows
 * (`dt:contains("Price") + dd`). Each one becomes an attribute that this document's elements
 * holding the text carry, so the rest of the selector stays native.
 */
function nativeSelector(selector: string, root: DomNode): string {
  const document = root instanceof Document
    ? root
    : root.ownerDocument
  return selector.replace(CONTAINS, (_match, literal: string) => {
    const text = unquote(literal)
    const marker = `data-site-to-api-contains-${[...text].reduce((hash, char) => (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 7).toString(36)}`
    if (document.documentElement.getAttribute(`${marker}-done`) === null) {
      for (const element of document.querySelectorAll('*')) {
        if ((element.textContent ?? '').includes(text))
          element.setAttribute(marker, '')
      }
      document.documentElement.setAttribute(`${marker}-done`, '')
    }
    return `[${marker}]`
  })
}

/** Extraction on the browser's `DOMParser`: no HTML parser in the bundle. */
export const domEngine: HtmlEngine<DomNode> = {
  parse: html => new DOMParser().parseFromString(html, 'text/html'),
  selectAll: (selector, root) => [
    ...root.querySelectorAll(nativeSelector(selector, root)),
  ],
  selectOne: (selector, root) => root.querySelector(nativeSelector(selector, root)),
  text: node => rootElement(node)?.textContent ?? '',
  attribute: (node, name) => node instanceof Element
    ? node.getAttribute(name)
    : null,
}
