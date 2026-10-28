/**
 * Escaping for every string the captured site controls (paths, media types, header and cookie
 * names, labels, page titles, sourcemap file paths) before it is written into a generated file.
 * Websites are untrusted input: a label or path must never close a comment or a code span, start
 * a heading, inject a link or HTML, or add statements to generated code.
 */

/**
 * Control and format characters, plus U+2028/U+2029, which end a line in JavaScript. Format
 * characters include the bidirectional overrides used to make code read differently than it
 * runs ("Trojan Source"), so they are removed rather than kept invisible.
 */
const LINE_BREAKING = /[\p{Cc}\u2028\u2029]/gu
const FORMAT = /\p{Cf}/gu

/** One line of plain text: control characters and line breaks become spaces, runs collapse. */
export function oneLine(value: string): string {
  return value
    .replace(FORMAT, '')
    .replace(LINE_BREAKING, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Text that is safe inside a `//`, `/* *\/` or `<!-- -->` comment: one line, `*\/` cannot close
 * a block comment and `-->` / `--!>` cannot close an HTML comment.
 */
export function commentText(value: string): string {
  return oneLine(value)
    .replace(/\*\//g, '*\\/')
    .replace(/--(?=!?>)/g, '-\\-')
}

/**
 * Inline Markdown text: one line, with every character that can start emphasis, a link, an image,
 * raw HTML, an entity, a code span, a table cell or a heading backslash-escaped. GFM also turns
 * bare `https://` text and email addresses into links; escaping the `:` and the `@` keeps them
 * plain text. (Bare
 * `www.` links are left alone: host names start with it, and the link text shows its target.)
 * The result is safe inside a GFM table cell (pipes are escaped).
 */
export function text(value: string): string {
  return oneLine(value)
    .replace(/[\\`*_[\]<>|#~!&@]/g, match => `\\${match}`)
    .replace(/:\/\//g, '\\://')
}

/**
 * Inline code span. CommonMark ends a code span at a backtick run of the same length as the
 * opening one, so the fence is one backtick longer than the longest run inside the value. HTML
 * and Markdown inside a code span are literal, so nothing else needs escaping.
 */
export function code(value: string): string {
  const flat = oneLine(value)
  if (flat === '')
    return '` `'
  const longest = Math.max(0, ...[
    ...flat.matchAll(/`+/g),
  ].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return longest > 0
    ? `${fence} ${flat} ${fence}`
    : `${fence}${flat}${fence}`
}

/**
 * {@link code} for a GFM table cell. The table parser splits a row at every `|` that is not
 * backslash-escaped, before it reads code spans, and a site value ending in `\` turns an escape
 * into a real cell boundary. Values without a pipe stay a plain code span (most readable when an
 * agent reads the raw file). A value with a pipe becomes an HTML `<code>` element whose characters
 * are all entities except letters, digits and spaces, so nothing in it can split the row, close
 * the element or form a link.
 */
export function cellCode(value: string): string {
  const flat = oneLine(value)
  if (!flat.includes('|'))
    return code(flat)
  const encoded = [...flat].map(char => /[\w ]/.test(char) && char !== '_'
    ? char
    : `&#${char.codePointAt(0)};`).join('')
  return `<code>${encoded}</code>`
}

/**
 * Fenced code block around `lines`. The fence is longer than any backtick run in the content, so
 * no line can close it early.
 */
export function codeBlock(lines: readonly string[], language: string): string[] {
  const longest = Math.max(2, ...lines.flatMap(line => [
    ...line.matchAll(/`+/g),
  ].map(match => match[0].length)))
  const fence = '`'.repeat(longest + 1)
  return [`${fence}${language}`, ...lines, fence]
}

/** A value usable as an HTML `id` and a URL fragment: lower-case letters, digits, `-` and `_`. */
export function anchor(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === ''
    ? 'section'
    : slug
}
