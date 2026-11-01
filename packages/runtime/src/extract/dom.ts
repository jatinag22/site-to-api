import type { HtmlEngine } from './engine'

type DomNode = Document | Element

/** `:contains("text")`, as `site-to-api build` writes it (a CSS string with `\"`, `\\` and `\a ` escapes). */
const CONTAINS = /:contains\(("(?:[^"\\]|\\[\s\S])*")\)/g

/** Marks the element a `:scope` selector starts from, while it runs. */
const SCOPE_MARKER = 'data-site-to-api-scope'

function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\a ?|\\([\s\S])/g, (escape, char: string | undefined) => char ?? '\n')
}

// Duck typing, not `instanceof`: a document from another realm (an iframe, a test DOM) has other
// constructors than the global ones.
function isDocument(node: DomNode): node is Document {
  return 'documentElement' in node
}

function documentOf(node: DomNode): Document {
  return isDocument(node)
    ? node
    : node.ownerDocument
}

function rootElement(node: DomNode): Element | null {
  return isDocument(node)
    ? node.documentElement
    : node
}

/**
 * The HTML parser adds `<tbody>` to every table that has none; htmlparser2, which `build` writes
 * selectors against, does not. Without `<tbody>` in the page, the added ones are unwrapped, so
 * `table > tr` matches in both.
 */
function withoutAddedTbody(document: Document, html: string): Document {
  if (/<tbody[\s>]/i.test(html))
    return document
  for (const tbody of [
    ...document.querySelectorAll('tbody'),
  ])
    tbody.replaceWith(...tbody.childNodes)
  return document
}

/**
 * Native selectors have no `:contains()`, which css-select has and `build` uses for label rows
 * (`dt:contains("Price") + dd`). Each one becomes an attribute that this document's elements
 * holding the text carry, so the rest of the selector stays native.
 */
function withoutContains(selector: string, document: Document): string {
  return selector.replace(CONTAINS, (_match, literal: string) => {
    const text = unquote(literal)
    const marker = `data-site-to-api-contains-${[...text].reduce((hash, char) => (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 7).toString(36)}`
    const done = `${marker}-done`
    if (document.documentElement.getAttribute(done) === null) {
      for (const element of document.querySelectorAll('*')) {
        if ((element.textContent ?? '').includes(text))
          element.setAttribute(marker, '')
      }
      document.documentElement.setAttribute(done, '')
    }
    return `[${marker}]`
  })
}

/**
 * Runs `selector` under `root` like css-select: descendants of `root`, and with `:scope` relative
 * to `root` itself, which a native call from `root` cannot reach for siblings (`:scope + tr`).
 */
function query(selector: string, root: DomNode): Element[] {
  const document = documentOf(root)
  const native = withoutContains(selector, document)
  if (isDocument(root) || !native.includes(':scope')) {
    return [
      ...root.querySelectorAll(native),
    ]
  }
  root.setAttribute(SCOPE_MARKER, '')
  try {
    return [
      ...document.querySelectorAll(native.replaceAll(':scope', `[${SCOPE_MARKER}]`)),
    ]
  }
  finally {
    root.removeAttribute(SCOPE_MARKER)
  }
}

/** Extraction on the browser's `DOMParser`: no HTML parser in the bundle. */
export const domEngine: HtmlEngine<DomNode> = {
  parse: html => withoutAddedTbody(new DOMParser().parseFromString(html, 'text/html'), html),
  selectAll: (selector, root) => query(selector, root),
  selectOne: (selector, root) => query(selector, root)[0] ?? null,
  text: node => rootElement(node)?.textContent ?? '',
  attribute: (node, name) => isDocument(node)
    ? null
    : node.getAttribute(name),
}
