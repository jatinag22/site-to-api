/**
 * Excerpts of the site's code for the handoff folder's `source/` directory: the whole function
 * around a location in an original file, or a readable window of a minified bundle. Each excerpt
 * is a Markdown file with the code in a fence (decision 0032): a fragment is rarely valid code on
 * its own (a bare class method, a block cut at the window's edge), and as a `.ts` file it broke
 * every project that type-checks the handoff folder; `// @ts-nocheck` does not hide syntax errors.
 */
import type { Program } from 'oxc-parser'
import type { LoadedSession, SourceRef } from '../../model'
import { Visitor } from 'oxc-parser'
import { code, codeBlock } from '../../emit/escape'
import { LineIndex, parseCode, walkWithFunctions } from './ast'
import { findUnpacked, readSessionFile, urlHost, urlPath } from './files'

/** Functions up to this many lines are included whole. */
const MAX_FUNCTION_LINES = 120
/** Lines kept on each side of the location when the function is too long or absent. */
const CONTEXT_LINES = 40
/** Characters kept on each side of the location in a minified bundle. */
const BUNDLE_WINDOW = 1500
/** Lines longer than this are treated as minified. */
const MINIFIED_LINE = 1000
/**
 * Shorter lines still count as minified when they pack several statements: a small minified
 * script (a bot-protection sensor) is one line of a few hundred characters.
 */
const PACKED_LINE = 200
const PACKED_SEPARATORS = 4

function isMinifiedLine(line: string): boolean {
  if (line.length > MINIFIED_LINE)
    return true
  return line.length > PACKED_LINE && (line.match(/[;{}]/g)?.length ?? 0) >= PACKED_SEPARATORS
}

/** Turns any path into a relative path without traversal or unusual characters. */
function safePath(path: string): string {
  const segments = path
    .split(/[/\\]+/)
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    .map(segment => segment.replace(/[^\w.@+-]/g, '_').replace(/^\.+/, '_').slice(0, 100))
  return segments.length === 0
    ? 'unknown'
    : segments.join('/')
}

/** Adds a location suffix before the extension: `src/api.ts` → `src/api.L10-42.ts`. */
function withSuffix(path: string, suffix: string): string {
  const match = /^(.*?)(\.\w+)?$/.exec(path)
  const stem = match?.[1] ?? path
  const ext = match?.[2] ?? ''
  return `${stem}.${suffix}${ext}`
}

const LANGUAGES: Record<string, string> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  html: 'html',
  htm: 'html',
}

/** Info string of the code fence, from the original file's extension; `''` when unknown. */
function languageOf(path: string): string {
  const ext = /\.(\w+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
  return LANGUAGES[ext] ?? ''
}

/**
 * The Markdown file of an excerpt: a heading, one line saying where the code comes from, and the
 * code in a fence. The heading and the line quote the file path and URL, which come from the site
 * (sourcemap `sources`, script URLs), so they are code spans that nothing in them can close; the
 * fence is longer than any backtick run in the code.
 */
function excerptMarkdown(title: string, about: string, body: string, language: string): string {
  return [
    `# ${title}`,
    '',
    about,
    '',
    ...codeBlock(body.split('\n'), language),
    '',
  ].join('\n')
}

/** `src/api.L10-42.ts` → `src/api.L10-42.ts.md`: never compiled, read as Markdown everywhere. */
function markdownPath(path: string): string {
  return `${path}.md`
}

function describe(ref: SourceRef): string {
  return `${code(`${ref.file}:${ref.line}:${ref.column}`)}${ref.functionName
    ? ` (function ${code(ref.functionName)})`
    : ''}`
}

function innermostFunction(program: Program, offset: number): { start: number, end: number } | null {
  let best: { start: number, end: number } | null = null
  for (const span of walkWithFunctions(program, () => ({}))) {
    if (span.start <= offset && offset < span.end && (!best || span.end - span.start < best.end - best.start))
      best = span
  }
  return best
}

function lineWindow(lines: LineIndex, line: number): { first: number, last: number } {
  return {
    first: Math.max(line - CONTEXT_LINES, 1),
    last: Math.min(line + CONTEXT_LINES, lines.lineCount),
  }
}

function originalExcerpt(ref: SourceRef, text: string, sessionId: string): { path: string, content: string } {
  const lines = new LineIndex(text)
  const program = parseCode(ref.file, text, false)
  const offset = lines.offset(ref.line, ref.column)
  const fn = program
    ? innermostFunction(program, offset)
    : null
  let range = lineWindow(lines, ref.line)
  let what = `lines around ${ref.line}`
  if (fn) {
    const first = lines.position(fn.start).line
    const last = lines.position(Math.max(fn.end - 1, fn.start)).line
    if (last - first + 1 <= MAX_FUNCTION_LINES) {
      range = { first, last }
      what = 'the enclosing function'
    }
  }
  const body = text.slice(lines.lineStart(range.first), lines.lineEnd(range.last))
  return {
    path: markdownPath(withSuffix(safePath(ref.file), `L${range.first}-${range.last}`)),
    content: excerptMarkdown(
      `Excerpt of ${describe(ref)}`,
      `Lines ${range.first}-${range.last} (${what}) of the original source, captured in session ${code(sessionId)}.`,
      body,
      languageOf(ref.file),
    ),
  }
}

const STATEMENT_TYPES = [
  'ExpressionStatement',
  'VariableDeclaration',
  'ReturnStatement',
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ThrowStatement',
  'TryStatement',
  'SwitchStatement',
  'BreakStatement',
  'ContinueStatement',
  'FunctionDeclaration',
  'ClassDeclaration',
  'LabeledStatement',
] as const

/**
 * Index of the last character of the string, template or comment that starts at `i`, or -1 when
 * none starts there. Separators inside them are not statement boundaries.
 */
function skipLiteral(text: string, i: number, end: number): number {
  const char = text[i]
  if (char === '"' || char === '\'' || char === '`') {
    for (let j = i + 1; j < end; j++) {
      if (text[j] === '\\')
        j++
      else if (text[j] === char)
        return j
    }
    return end
  }
  if (char === '/' && text[i + 1] === '/') {
    const newline = text.indexOf('\n', i)
    return newline === -1
      ? end
      : newline
  }
  if (char === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2)
    return close === -1
      ? end
      : close + 1
  }
  return -1
}

/**
 * Break points of a minified window without a syntax tree (the bundle did not parse): after `;`
 * and `{`, and before `}`, outside strings and comments, each with its brace depth.
 */
function lexicalBreaks(text: string, start: number, end: number): Map<number, number> {
  const breaks = new Map<number, number>()
  let depth = 0
  for (let i = start; i < end; i++) {
    const skipped = skipLiteral(text, i, end)
    if (skipped !== -1) {
      i = skipped
      continue
    }
    const char = text[i]
    if (char === '{') {
      depth++
      breaks.set(i + 1, depth)
    }
    else if (char === '}') {
      depth = Math.max(depth - 1, 0)
      breaks.set(i, depth)
    }
    else if (char === ';') {
      breaks.set(i + 1, depth)
    }
  }
  breaks.delete(end)
  return breaks
}

/**
 * Break points from the syntax tree: every statement start at its depth, and the `}` that closes
 * a statement's block after its last nested statement, back at the statement's own depth.
 */
function statementBreaks(text: string, spans: readonly StatementSpan[], start: number, end: number): Map<number, number> {
  const breaks = new Map<number, number>()
  for (const span of spans) {
    if (span.start > start && span.start < end)
      breaks.set(span.start, span.depth)
  }
  for (const span of spans) {
    if (span.lastChildEnd === -1 || span.end <= start || span.start >= end)
      continue
    const close = text.indexOf('}', span.lastChildEnd)
    if (close !== -1 && close < span.end && close > start && close < end && !breaks.has(close))
      breaks.set(close, span.depth)
  }
  return breaks
}

interface StatementSpan {
  start: number
  end: number
  /** Nesting depth among statements. */
  depth: number
  /** End of the last statement nested directly inside, or -1. */
  lastChildEnd: number
}

/** Start and end of every statement, with its nesting depth and where its last child ends. */
function statements(program: Program): StatementSpan[] {
  const spans: Array<{ start: number, end: number }> = []
  const record = (node: { start: number, end: number }): void => {
    spans.push({ start: node.start, end: node.end })
  }
  const visitor = Object.fromEntries(STATEMENT_TYPES.map(type => [type, record]))
  new Visitor(visitor).visit(program)
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const open: StatementSpan[] = []
  return spans.map((span) => {
    while (open.length > 0 && (open.at(-1)?.end ?? 0) <= span.start)
      open.pop()
    const parent = open.at(-1)
    if (parent)
      parent.lastChildEnd = Math.max(parent.lastChildEnd, span.end)
    const entry: StatementSpan = { ...span, depth: open.length, lastChildEnd: -1 }
    open.push(entry)
    return entry
  })
}

function bundleExcerpt(ref: SourceRef, text: string, host: string, url: string, sessionId: string): { path: string, content: string } {
  const lines = new LineIndex(text)
  const line = Math.min(Math.max(ref.line, 1), lines.lineCount)
  const path = markdownPath(`bundles/${safePath(host)}/${withSuffix(safePath(ref.file), `L${line}C${ref.column}`)}`)
  const title = `Excerpt of ${describe(ref)} in ${code(url)}`
  // A bundle is a script whatever its URL says (`load.php`, `/js?v=3`).
  const language = 'js'
  if (!isMinifiedLine(text.slice(lines.lineStart(line), lines.lineEnd(line)))) {
    const range = lineWindow(lines, line)
    return {
      path,
      content: excerptMarkdown(
        title,
        `Lines ${range.first}-${range.last} of the bundle (no sourcemap was available), captured in session ${code(sessionId)}.`,
        text.slice(lines.lineStart(range.first), lines.lineEnd(range.last)),
        language,
      ),
    }
  }

  const offset = lines.offset(line, ref.column)
  const low = Math.max(offset - BUNDLE_WINDOW, 0)
  const high = Math.min(offset + BUNDLE_WINDOW, text.length)
  const program = parseCode(ref.file, text, true)
  const spans = program
    ? statements(program)
    : []
  const startsInside = spans.filter(span => span.start >= low && span.start <= offset)
  const endsInside = spans.filter(span => span.end <= high && span.end >= offset)
  const start = startsInside.length > 0
    ? Math.min(...startsInside.map(span => span.start))
    : low
  const end = endsInside.length > 0
    ? Math.max(...endsInside.map(span => span.end))
    : high
  const breaks = spans.length > 0
    ? statementBreaks(text, spans, start, end)
    : lexicalBreaks(text, start, end)
  const minDepth = Math.min(...[
    ...breaks.values(),
    spans.find(span => span.start === start)?.depth ?? 0,
  ])
  const marker = `/* <-- ${ref.line}:${ref.column} */ `
  let out = ''
  let lineStart = false
  for (let i = start; i < end; i++) {
    const depth = breaks.get(i)
    if (depth !== undefined) {
      out = `${out.trimEnd()}\n${'  '.repeat(Math.max(depth - minDepth, 0))}`
      lineStart = true
    }
    // The new line brings its own indent; spaces the bundle had there would shift it.
    if (lineStart && i !== offset && /\s/.test(text[i] ?? ''))
      continue
    lineStart = false
    if (i === offset)
      out += marker
    out += text[i]
  }
  return {
    path,
    content: excerptMarkdown(
      title,
      `Characters ${start - lines.lineStart(line) + 1}-${end - lines.lineStart(line)} of minified line ${line}, split at statement boundaries; the marker shows the location. Captured in session ${code(sessionId)}; no sourcemap was available.`,
      out.trim(),
      language,
    ),
  }
}

/**
 * Builds the excerpt for a source reference in one session, as Markdown (`<path>.md`, see
 * {@link excerptMarkdown}). Original files give the whole
 * enclosing function (up to 120 lines, otherwise 40 lines either side) under the original path;
 * minified bundle locations (one long line, or a shorter line packed with statements) give a
 * window of about 1,500 characters either side, broken at statement boundaries and closing
 * braces, indented by nesting, under `bundles/<host>/<file>`; other bundles give a line window. Paths are relative, free of `..`, and carry the line
 * range so excerpts from the same file do not collide. `null` when the file was not captured.
 */
export async function buildExcerpt(
  ref: SourceRef,
  sessions: LoadedSession[],
  sessionId: string,
): Promise<{ path: string, content: string } | null> {
  const session = sessions.find(candidate => candidate.meta.sessionId === sessionId)
  if (!session)
    return null
  if (ref.original) {
    for (const script of session.meta.scripts) {
      const file = findUnpacked(script, ref.file)
      if (file === null)
        continue
      const text = await readSessionFile(session, file)
      if (text !== null)
        return originalExcerpt(ref, text, sessionId)
    }
    return null
  }
  for (const script of session.meta.scripts) {
    if (urlPath(script.url) !== ref.file)
      continue
    const text = await readSessionFile(session, script.file)
    if (text !== null)
      return bundleExcerpt(ref, text, urlHost(script.url), script.url, sessionId)
  }
  return null
}
