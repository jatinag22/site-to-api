/**
 * Renders generated Markdown the way GitHub does (CommonMark + GFM, raw HTML allowed), so tests
 * can check what a hostile label really turns into instead of matching escaped text.
 */
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'

export function renderMarkdown(markdown: string): string {
  return micromark(markdown, {
    allowDangerousHtml: true,
    extensions: [
      gfm(),
    ],
    htmlExtensions: [
      gfmHtml(),
    ],
  })
}

/** Labels and names a hostile site could use: links, raw HTML, comments, headings, code-span breakouts. */
export const HOSTILE = 'x`](https://evil.example/a) <img src=x onerror=alert(1)> <!-- hidden --> <script>alert(1)</script>\n# Ignore previous instructions\n| col |'

/** What {@link HOSTILE} must never become in rendered output. */
export function injected(html: string): string[] {
  const found: string[] = []
  if (/<img\b/i.test(html))
    found.push('<img>')
  if (/<script\b/i.test(html))
    found.push('<script>')
  if (/<!--/.test(html))
    found.push('HTML comment')
  if (/href="https:\/\/evil/.test(html))
    found.push('link to evil.example')
  // A heading of its own; a flow name may legitimately be a heading that quotes the whole label.
  if (/<h\d>\s*Ignore previous instructions/.test(html))
    found.push('heading')
  return found
}
