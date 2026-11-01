/**
 * The HTML operations extraction needs, so the same rules run on htmlparser2 (Node, Bun, Deno,
 * edge workers) and on the browser's own `DOMParser`, which keeps an HTML parser out of browser
 * bundles (site-to-api decision 0057). `N` is the engine's node type.
 */
export interface HtmlEngine<N> {
  /** The document of `html`. */
  parse: (html: string) => N
  /** Elements under `root` matching `selector` (`:contains("text")` included). Throws on an invalid selector. */
  selectAll: (selector: string, root: N) => N[]
  /** The first of {@link HtmlEngine.selectAll}, or null. */
  selectOne: (selector: string, root: N) => N | null
  /** Text of the node and everything inside it, as written in the page. */
  text: (node: N) => string
  /** The attribute's value, or null when the node is not an element or has no such attribute. */
  attribute: (node: N, name: string) => string | null
}
