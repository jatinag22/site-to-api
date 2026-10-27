/**
 * Regex building blocks for values that sit inside longer text: an inline script, a sentence,
 * part of an attribute. Patterns always have exactly one capture group (the value).
 */

export function escapeRegex(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')
}

/** Escapes literal text and lets any run of whitespace match any amount of whitespace. */
export function looseLiteral(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegex)
    .join('\\s*')
}

/**
 * Capture group for a value, chosen so it stops where the value stops: before the quote or tag
 * that follows it, or by the value's own character classes.
 */
function captureFor(value: string, follower: string): string {
  if (follower === '"')
    return '([^"]*)'
  if (follower === '\'')
    return '([^\']*)'
  if (follower === '<')
    return '([^<]*)'
  if (/^\d+$/.test(value))
    return '(\\d+)'
  if (/^[\w-]+$/.test(value))
    return '([\\w-]+)'
  if (/^[\w+/=.-]+$/.test(value))
    return '([\\w+/=.-]+)'
  return '([^\\s"\'<>,;&]+)'
}

/** Runs a one-group pattern the way extraction does and returns the captured value. */
export function capture(pattern: string, input: string): string | null {
  return new RegExp(pattern).exec(input)?.[1] ?? null
}

/**
 * A pattern that finds `value` at `index` in `input` from the text before it: tries ever longer
 * anchors (starting at a quote, word or punctuation boundary) until the first match of the
 * pattern captures exactly this occurrence. `null` if no anchor of up to 80 characters works.
 */
export function anchoredPattern(input: string, index: number, value: string): string | null {
  const follower = input.charAt(index + value.length)
  const group = captureFor(value, follower)
  const before = input.slice(Math.max(0, index - 80), index)
  if (before.trim() === '') {
    // Nothing usable before the value: anchor on the start of the text plus what follows.
    const after = input.slice(index + value.length, index + value.length + 40).split(/\n/)[0] ?? ''
    const pattern = `^\\s*${group}${after.trim() === ''
      ? ''
      : `\\s*${looseLiteral(after.slice(0, 20))}`}`
    return capture(pattern, input) === value && new RegExp(pattern).exec(input)?.index === 0
      ? pattern
      : null
  }
  for (let length = 3; length <= before.length; length++) {
    const anchorText = before.slice(before.length - length)
    // Start anchors at a boundary so they read as `"csrfToken":"` rather than `rfToken":"`.
    const startsClean = length === before.length || /[\s{,;:(=>[]/.test(before.charAt(before.length - length - 1))
    if (!startsClean || anchorText.trim() === '')
      continue
    const trailingSpace = /\s$/.test(anchorText)
      ? '\\s*'
      : ''
    const pattern = `${looseLiteral(anchorText)}${trailingSpace}${group}`
    const match = new RegExp(pattern).exec(input)
    if (match && match[1] === value && match.index + match[0].length === index + value.length)
      return pattern
  }
  return null
}
