/**
 * Excerpts of the site's code for the handoff folder's `source/` directory: the whole function
 * around a location in an original file, or a readable window of a minified bundle.
 */
import type { Program } from 'oxc-parser'
import type { LoadedSession, SourceRef } from '../../model'
import { Visitor } from 'oxc-parser'
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

function commentFor(path: string): (line: string) => string {
  return /\.(?:vue|svelte|html?|astro)$/i.test(path)
    ? line => `<!-- ${line} -->`
    : line => `// ${line}`
}

function describe(ref: SourceRef): string {
  return `${ref.file}:${ref.line}:${ref.column}${ref.functionName
    ? ` (function ${ref.functionName})`
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
  const comment = commentFor(ref.file)
  const header = [
    comment(`site-to-api excerpt of ${describe(ref)}`),
    comment(`Lines ${range.first}-${range.last} (${what}) of the original source, captured in session ${sessionId}.`),
  ]
  const body = text.slice(lines.lineStart(range.first), lines.lineEnd(range.last))
  return {
    path: withSuffix(safePath(ref.file), `L${range.first}-${range.last}`),
    content: `${header.join('\n')}\n${body}\n`,
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

/** Start and end of every statement, with its nesting depth among statements. */
function statements(program: Program): Array<{ start: number, end: number, depth: number }> {
  const spans: Array<{ start: number, end: number }> = []
  const record = (node: { start: number, end: number }): void => {
    spans.push({ start: node.start, end: node.end })
  }
  const visitor = Object.fromEntries(STATEMENT_TYPES.map(type => [type, record]))
  new Visitor(visitor).visit(program)
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const open: Array<{ end: number }> = []
  return spans.map((span) => {
    while (open.length > 0 && (open.at(-1)?.end ?? 0) <= span.start)
      open.pop()
    const depth = open.length
    open.push(span)
    return { ...span, depth }
  })
}

function bundleExcerpt(ref: SourceRef, text: string, host: string, url: string, sessionId: string): { path: string, content: string } {
  const lines = new LineIndex(text)
  const line = Math.min(Math.max(ref.line, 1), lines.lineCount)
  const comment = commentFor(ref.file)
  const path = `bundles/${safePath(host)}/${withSuffix(safePath(ref.file), `L${line}C${ref.column}`)}`
  const lineLength = lines.lineEnd(line) - lines.lineStart(line)
  if (lineLength <= MINIFIED_LINE) {
    const range = lineWindow(lines, line)
    const header = [
      comment(`site-to-api excerpt of ${describe(ref)} in ${url}`),
      comment(`Lines ${range.first}-${range.last} of the bundle (no sourcemap was available), captured in session ${sessionId}.`),
    ]
    return { path, content: `${header.join('\n')}\n${text.slice(lines.lineStart(range.first), lines.lineEnd(range.last))}\n` }
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
  const breaks = new Map<number, number>()
  for (const span of spans) {
    if (span.start > start && span.start < end)
      breaks.set(span.start, span.depth)
  }
  const minDepth = Math.min(...[
    ...breaks.values(),
    spans.find(span => span.start === start)?.depth ?? 0,
  ])
  const marker = `/* <-- ${ref.line}:${ref.column} */ `
  let out = ''
  for (let i = start; i < end; i++) {
    const depth = breaks.get(i)
    if (depth !== undefined)
      out = `${out.trimEnd()}\n${'  '.repeat(Math.max(depth - minDepth, 0))}`
    if (i === offset)
      out += marker
    out += text[i]
  }
  const header = [
    comment(`site-to-api excerpt of ${describe(ref)} in ${url}`),
    comment(`Characters ${start - lines.lineStart(line) + 1}-${end - lines.lineStart(line)} of minified line ${line}, split at statement boundaries; the marker shows the location. Captured in session ${sessionId}; no sourcemap was available.`),
  ]
  return { path, content: `${header.join('\n')}\n${out.trim()}\n` }
}

/**
 * Builds the excerpt for a source reference in one session. Original files give the whole
 * enclosing function (up to 120 lines, otherwise 40 lines either side) under the original path;
 * bundle locations give a window of about 1,500 characters either side, broken into one statement
 * per line, under `bundles/<host>/<file>`. Paths are relative, free of `..`, and carry the line
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
