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
 * A number of three or more digits or a decimal with three or more places: data (a size
 * `[512,433]`, an id, a coordinate), not part of a page's template.
 */
const DATA_NUMBER = /\d{3,}|\d\.\d{3,}/

/**
 * A run of 16 or more token characters mixing letters and digits: another session value next to
 * this one (`?q=<encrypted>&state=`), or the cut-off tail of one at the anchor's start.
 */
const TOKEN_RUN = /[\w+-]{16,}={0,2}/g

function isTokenRun(run: string): boolean {
  return /\d/.test(run) && /[a-z]/i.test(run)
}

/**
 * The anchor as a pattern, with every token run in it matched by its character class rather than
 * literally: written literally it leaks that session's value and finds nothing in the next one.
 */
function anchorLiteral(text: string): string {
  const runs = [
    ...text.matchAll(TOKEN_RUN),
  ].filter(match => isTokenRun(match[0]))
  if (runs.length === 0)
    return looseLiteral(text)
  let pattern = ''
  let from = 0
  for (const run of runs) {
    pattern += escapeRegex(text.slice(from, run.index).replace(/\s+/g, ' ')).replace(/ /g, '\\s*')
    pattern += /^[\w-]+$/.test(run[0])
      ? '[\\w-]+'
      : '[\\w+=-]+'
    from = run.index + run[0].length
  }
  return pattern + escapeRegex(text.slice(from).replace(/\s+/g, ' ')).replace(/ /g, '\\s*')
}

/** The anchor text with its token runs left out, for checks on the literal part. */
function withoutTokenRuns(text: string): string {
  return text.replace(TOKEN_RUN, run => isTokenRun(run)
    ? ' '
    : run)
}

/**
 * A pattern that finds `value` at `index` in `input` from the text before it: tries ever longer
 * anchors (starting at a quote, word or punctuation boundary) until the first match of the
 * pattern captures exactly this occurrence. Anchors holding data numbers are never used. `null`
 * if no anchor of up to 80 characters works.
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
    // An anchor holding data (a coordinate `13.40538024902344`, an id, a timestamp) only finds
    // the value on this one page: the next page has another number there.
    if (!startsClean || anchorText.trim() === '' || DATA_NUMBER.test(withoutTokenRuns(anchorText)))
      continue
    const trailingSpace = /\s$/.test(anchorText)
      ? '\\s*'
      : ''
    const pattern = `${anchorLiteral(anchorText.trim())}${trailingSpace}${group}`
    const match = new RegExp(pattern).exec(input)
    if (match && match[1] === value && match.index + match[0].length === index + value.length)
      return pattern
  }
  return null
}

const MIN_LEARNT_WORD = 6

/**
 * True when a word of `text` (split at anything but letters, digits and `._@+-`, six characters
 * or more) is a learnt
 * person's value: a pattern anchored on the signed-in user's name works for that user only.
 */
export function holdsLearntWord(text: string, isLearnt: (value: string) => boolean): boolean {
  // Short names (`jdoe`) are learnt for whole path segments only; in prose they match words.
  return text.split(/[^\w.@+-]+/).some(word => word.length >= MIN_LEARNT_WORD && isLearnt(word))
}
