import type { LoadedSession, SessionMeta } from '../../model'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
/**
 * Access to the scripts, sourcemaps and unpacked original sources a capture saved
 * (`meta.scripts`, see `src/model/capture.ts`). Paths in `meta.json` come from disk, so every one
 * is checked to stay inside the session directory before it is read.
 */
import { redactPathTokens } from '../redact'

type ScriptEntry = SessionMeta['scripts'][number]

/** Absolute path of a file listed in `meta.json`, or `null` when it would escape the session directory. */
export function sessionPath(session: Pick<LoadedSession, 'dir'>, file: string): string | null {
  const absolute = resolve(session.dir, file)
  const rel = relative(session.dir, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    return null
  return absolute
}

/** Reads a session file as UTF-8; `null` when it is missing or outside the session directory. */
export async function readSessionFile(session: LoadedSession, file: string): Promise<string | null> {
  const path = sessionPath(session, file)
  if (path === null)
    return null
  try {
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null
    throw error
  }
}

/**
 * Normalises a sourcemap source name to a relative project path: drops `webpack://<name>/`,
 * other URL schemes, `./` and `../` segments, so `webpack://shop/./src/api.ts` becomes
 * `src/api.ts`. Keeps `node_modules/` so library code can still be recognised.
 */
export function normalizeSourcePath(source: string): string {
  let path = source.replace(/[?#].*$/, '')
  const scheme = /^[a-z][\w+.-]*:\/\/\/?/i.exec(path)
  if (scheme) {
    path = path.slice(scheme[0].length)
    // `webpack://<project>/src/x.ts` and `https://<host>/src/x.ts`: the first segment names the
    // bundler project or the host, not a folder. `webpack:///src/x.ts` has no such segment.
    const namesProject = /^(?:webpack|https?):\/\/$/i.test(scheme[0]) && !path.startsWith('.') && path.includes('/')
    if (namesProject)
      path = path.slice(path.indexOf('/') + 1)
  }
  const segments: string[] = []
  for (const segment of path.split(/[/\\]+/)) {
    if (segment === '' || segment === '.' || segment === '..')
      continue
    segments.push(segment)
  }
  return segments.join('/')
}

/** URL path of a script (`/static/js/main.js`), or the input when it is not a URL. */
export function urlPath(url: string): string {
  try {
    return redactPathTokens(new URL(url).pathname)
  }
  catch {
    return redactPathTokens(url.split(/[?#]/)[0] ?? '')
  }
}

/**
 * A script URL as the handoff folder may show it: origin and path with token segments replaced,
 * and no query or fragment. Script URLs carry session values (`ips.js?KP_UIDz=...`,
 * `app.js?token=...`) that no rule would recognise by shape.
 */
export function displayScriptUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const rest = parsed.search !== '' || parsed.hash !== ''
      ? '?<query omitted>'
      : ''
    return `${parsed.origin}${redactPathTokens(parsed.pathname)}${rest}`
  }
  catch {
    return urlPath(url)
  }
}

/** Host of a URL, or `unknown` for non-URLs (inline scripts reported by odd browsers). */
export function urlHost(url: string): string {
  try {
    return new URL(url).host || 'unknown'
  }
  catch {
    return 'unknown'
  }
}

/** True for original paths that belong to third-party libraries. */
export function isLibraryPath(path: string): boolean {
  return /(?:^|\/)node_modules\//.test(path) || /(?:^|\/)(?:bower_components|jspm_packages)\//.test(path)
}

/** One file of the site's code that can be parsed. */
export interface CodeFile {
  /** `original` when unpacked from a sourcemap, `bundle` when it is the script the page loaded. */
  kind: 'original' | 'bundle'
  /** Path used in {@link SourceRef.file}: normalised original path, or the bundle URL path. */
  path: string
  /** Host of the script the file belongs to. */
  host: string
  /** Path relative to the session directory. */
  file: string
}

/** The unpacked file that holds an original source, matched by its normalised path. */
export function findUnpacked(script: ScriptEntry, originalPath: string): string | null {
  const unpacked = script.sourceMap?.sources ?? []
  let best: string | null = null
  for (const file of unpacked) {
    const normalized = normalizeSourcePath(file)
    const matches = normalized === originalPath || normalized.endsWith(`/${originalPath}`)
    // The shortest match is the least ambiguous when two projects ship the same relative path.
    if (matches && (best === null || file.length < best.length))
      best = file
  }
  return best
}

/**
 * Original path of an unpacked file: `sources/<host>/src/api.ts` → `src/api.ts`. The capture step
 * stores originals under `sources/<host>/`; anything else is normalised as-is.
 */
export function originalPathOf(file: string, host: string): string {
  const normalized = normalizeSourcePath(file)
  const prefix = `sources/${host}/`
  return normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized
}

/**
 * The site's own code files in a session, in a deterministic order: original sources when the
 * script had a sourcemap with unpacked sources (library files under `node_modules/` excluded),
 * otherwise the bundle itself.
 */
export function siteCodeFiles(session: LoadedSession): CodeFile[] {
  const files: CodeFile[] = []
  const seen = new Set<string>()
  for (const script of session.meta.scripts) {
    const host = urlHost(script.url)
    const originals = script.sourceMap?.sources ?? []
    if (originals.length > 0) {
      for (const file of originals) {
        const path = originalPathOf(file, host)
        const key = `original:${host}:${path}`
        if (isLibraryPath(path) || seen.has(key))
          continue
        seen.add(key)
        files.push({ kind: 'original', path, host, file })
      }
      continue
    }
    const key = `bundle:${script.file}`
    if (seen.has(key))
      continue
    seen.add(key)
    files.push({
      kind: 'bundle',
      path: urlPath(script.url),
      host,
      file: script.file,
    })
  }
  return files.sort((a, b) => compare(a.host, b.host) || compare(a.path, b.path) || compare(a.kind, b.kind))
}

/** Locale-independent string comparison, so output order never depends on the machine. */
export function compare(a: string, b: string): number {
  return a < b
    ? -1
    : a > b
      ? 1
      : 0
}
