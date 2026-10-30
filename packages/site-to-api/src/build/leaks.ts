/**
 * The leak check `build` runs on its own output (decision 0047): every secret the redactor learnt
 * from the raw capture is looked for in every file of the handoff folder. Redaction rules miss
 * new shapes (a token in a WebSocket URL inside a frame), so the tool checks what it wrote
 * instead of trusting the rules.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'pathe'
import { SiteToApiError } from '../errors'

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

/** Text files of the handoff folder, relative paths sorted; dependencies installed into it are skipped. */
async function handoffFiles(outDir: string): Promise<Array<{ path: string, content: string }>> {
  const entries = await readdir(outDir, { recursive: true, withFileTypes: true })
  const paths = entries
    .filter(entry => entry.isFile())
    .map(entry => relative(outDir, join(entry.parentPath, entry.name)))
    .filter(path => !path.split('/').includes('node_modules'))
    .sort()
  return Promise.all(paths.map(async path => ({ path, content: await readFile(join(outDir, path), 'utf8') })))
}

/** {@link findLeaks} over every file of the handoff folder. */
export async function findHandoffLeaks(outDir: string, secrets: readonly string[]): Promise<Leak[]> {
  return findLeaks(await handoffFiles(outDir), secrets)
}

/** The error that fails `build` when the check found anything. */
export function leakError(outDir: string, leaks: readonly Leak[]): SiteToApiError {
  const listed = leaks.slice(0, MAX_LISTED).map(leak => `  ${leak.file}: ${leak.hint}`)
  const more = leaks.length > MAX_LISTED
    ? [`  … and ${leaks.length - MAX_LISTED} more`]
    : []
  return new SiteToApiError([
    `Leak check failed: ${leaks.length} secret value(s) learnt from the capture appear in ${outDir}:`,
    ...listed,
    ...more,
    'This is a redaction bug in site-to-api. Do not share or commit this folder; delete it, and report the file names and value shapes above (never the values).',
  ].join('\n'))
}
