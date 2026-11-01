/**
 * The leak check `build` runs on its own output (decision 0047): every secret the redactor learnt
 * from the raw capture is looked for in every file of the handoff folder. Redaction rules miss
 * new shapes (a token in a WebSocket URL inside a frame), so the tool checks what it wrote
 * instead of trusting the rules.
 */
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'pathe'
import { SiteToApiError } from '../errors'
import { insideAny } from '../gen/contained'

/** One learnt secret found in one output file. */
export interface Leak {
  /** Path relative to the handoff folder. */
  file: string
  /** The value with all but its ends hidden: `PH8…Q= (40 chars)`. */
  hint: string
}

/** Leaks listed in the error; the rest are counted. */
const MAX_LISTED = 10

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Enough of a value to find it in the capture, not enough to use it. */
export function maskedHint(value: string): string {
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`
}

/**
 * Every (file, secret) pair where the secret appears in the file's text, in file order, then in
 * order of first appearance. Longer secrets win where one contains another.
 */
export function findLeaks(files: ReadonlyArray<{ path: string, content: string }>, secrets: readonly string[]): Leak[] {
  if (secrets.length === 0)
    return []
  const pattern = new RegExp([...secrets].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(escapeRegExp).join('|'), 'g')
  const leaks: Leak[] = []
  for (const file of files) {
    const seen = new Set<string>()
    for (const match of file.content.matchAll(pattern)) {
      if (seen.has(match[0]))
        continue
      seen.add(match[0])
      leaks.push({
        file: file.path,
        hint: maskedHint(match[0]),
      })
    }
  }
  return leaks
}

/** True when `dir` is `other` or contains it. */
function containsOrEquals(dir: string, other: string): boolean {
  const path = relative(dir, other)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Throws unless `outDir` is a folder of its own: not the working directory or a folder holding
 * it, and not holding the raw captures. The leak check reads and deletes only what `build` wrote,
 * but a handoff folder mixed with the project's own files invites committing everything in it.
 */
export function assertOwnOutDir(outDir: string, cwd: string, rawDir: string): void {
  if (containsOrEquals(outDir, cwd))
    throw new SiteToApiError(`outDir ${outDir} is the project folder (or holds it). Set outDir to a folder of its own, such as "api-handoff".`)
  if (containsOrEquals(outDir, rawDir))
    throw new SiteToApiError(`outDir ${outDir} holds the raw captures (${rawDir}), which must never be shared. Set outDir to a folder of its own, such as "api-handoff", outside rawDir.`)
}

/**
 * {@link findLeaks} over `written`, the absolute paths `build` wrote or manages, reported
 * relative to `outDir` (a client in `gen.clientDir` shows as `../client/…`). Nothing else is
 * read: the user's own files are neither the tool's output nor its business.
 */
export async function findHandoffLeaks(outDir: string, written: readonly string[], secrets: readonly string[], roots: readonly string[] = [outDir]): Promise<Leak[]> {
  const paths: string[] = []
  // Only regular files inside the handoff, client or MCP folder: the recorded client files come
  // from build.json, which a repository controls (decision 0058).
  for (const path of [
    ...new Set(written),
  ].sort()) {
    if (existsSync(path) && await insideAny(roots, path))
      paths.push(path)
  }
  const files = await Promise.all(paths.map(async path => ({
    path: relative(outDir, path),
    content: await readFile(path, 'utf8'),
  })))
  return findLeaks(files, secrets)
}

/**
 * Deletes the files the leak check found, so no leaking file stays on disk. Only those files:
 * they are all files `build` wrote ({@link findHandoffLeaks}). Returns what was done, for the error.
 */
export async function discardLeakingOutput(outDir: string, leaks: readonly Leak[], roots: readonly string[] = [outDir]): Promise<string> {
  const files = [
    ...new Set(leaks.map(leak => leak.file)),
  ]
  for (const file of files) {
    // Checked again right before deleting: never through a link, never outside the folders.
    if (await insideAny(roots, join(outDir, file)))
      await rm(join(outDir, file), { force: true })
  }
  return `The ${files.length} file(s) listed were deleted so the values cannot be shared; the rest of ${outDir} is incomplete until build runs again after the fix.`
}

/** The error that fails `build` when the check found anything; `removed` says what was deleted. */
export function leakError(outDir: string, leaks: readonly Leak[], removed: string): SiteToApiError {
  const listed = leaks.slice(0, MAX_LISTED).map(leak => `  ${leak.file}: ${leak.hint}`)
  const more = leaks.length > MAX_LISTED
    ? [`  … and ${leaks.length - MAX_LISTED} more`]
    : []
  return new SiteToApiError([
    `Leak check failed: ${leaks.length} secret value(s) learnt from the capture appear in ${outDir}:`,
    ...listed,
    ...more,
    removed,
    'This is a redaction bug in site-to-api: report the file names and value shapes above (never the values).',
  ].join('\n'))
}
