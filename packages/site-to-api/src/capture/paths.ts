/**
 * File naming for everything `capture` writes. Names come from URLs and sourcemap `sources`
 * entries that the site controls, so every path is sanitised segment by segment and checked to
 * stay inside the session directory before anything is written.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { SiteToApiError } from '../errors'

/** Longest file or directory name we write; most file systems allow 255 bytes. */
const MAX_SEGMENT = 120
/** Marker for a `..` that would climb above the root; keeps paths distinct without traversal. */
const ESCAPED_PARENT = '__'

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

function splitExtension(name: string): { stem: string, ext: string } {
  const dot = name.lastIndexOf('.')
  // A leading dot is a hidden file, not an extension; very long "extensions" are just names.
  if (dot <= 0 || name.length - dot > 12)
    return { stem: name, ext: '' }
  return {
    stem: name.slice(0, dot),
    ext: name.slice(dot),
  }
}

/**
 * Makes one path segment safe to use as a file name: decodes percent escapes, replaces anything
 * outside a conservative character set and caps the length (keeping the extension and adding a
 * hash so truncated names stay unique). `.` and `..` are returned unchanged for the caller to
 * normalise.
 */
export function sanitizeSegment(segment: string): string {
  const decoded = safeDecode(segment)
  if (decoded === '.' || decoded === '..')
    return decoded
  let clean = decoded.replaceAll(/[^\w.\-~@+=,]/g, '_')
  // Only dots would read as `.`/`..` on some systems after trimming.
  if (/^\.+$/.test(clean))
    clean = clean.replaceAll('.', '_')
  if (clean.length <= MAX_SEGMENT)
    return clean
  const { stem, ext } = splitExtension(clean)
  return `${stem.slice(0, MAX_SEGMENT - ext.length - 9)}~${shortHash(clean)}${ext}`
}

/**
 * Splits a path on `/` and `\`, sanitises each segment and resolves `.` and `..` without ever
 * climbing above the root: a `..` with nothing left to pop becomes a literal `__` directory.
 */
export function normalizeSegments(rawPath: string): string[] {
  const out: string[] = []
  for (const part of rawPath.split(/[/\\]+/)) {
    if (part === '')
      continue
    const segment = sanitizeSegment(part)
    if (segment === '.')
      continue
    if (segment === '..') {
      if (out.length > 0 && out.at(-1) !== ESCAPED_PARENT)
        out.pop()
      else
        out.push(ESCAPED_PARENT)
      continue
    }
    out.push(segment)
  }
  return out
}

/** Directory name for a URL host; the port separator is not allowed on every file system. */
export function hostDir(url: URL): string {
  return sanitizeSegment(url.host.replace(':', '_')) || 'unknown-host'
}

/** Puts a hash of the query string into the last segment, before its extension. */
function withQueryHash(segments: string[], query: string): string[] {
  if (query === '' || segments.length === 0)
    return segments
  const last = segments.at(-1) ?? ''
  const { stem, ext } = splitExtension(last)
  return [
    ...segments.slice(0, -1),
    sanitizeSegment(`${stem}~${shortHash(query)}${ext}`),
  ]
}

/**
 * Path of a saved script relative to the session directory: `scripts/<host>/<path>`.
 * Extensionless names get `.js` so `/a/b` (a file) and `/a/b/c.js` (needs `a/b` as a directory)
 * cannot collide.
 */
export function scriptFilePath(scriptUrl: string): string {
  const url = new URL(scriptUrl)
  let segments = normalizeSegments(url.pathname)
  if (segments.length === 0 || url.pathname.endsWith('/'))
    segments.push('index.js')
  else if (splitExtension(segments.at(-1) ?? '').ext === '')
    segments[segments.length - 1] = `${segments.at(-1) ?? ''}.js`
  segments = withQueryHash(segments, url.search)
  return [
    'scripts',
    hostDir(url),
    ...segments,
  ].join('/')
}

/** Path of a sourcemap saved for a script, relative to the session directory. */
export function sourceMapFilePath(scriptFile: string): string {
  return `${scriptFile.replace(/^scripts\//, 'sourcemaps/')}.map`
}

/**
 * Path of an original file unpacked from a sourcemap, relative to the session directory:
 * `sources/<host>/<path>`. Bundler prefixes such as `webpack://`, `vite://` or `file://` are
 * removed and `sourceRoot` is applied the way the sourcemap spec describes.
 *
 * `analyze/source` needs the same mapping from a map's `sources` entry to a file, so this is a
 * pure function of its inputs.
 */
export function sourceFilePath(host: string, source: string, sourceRoot: string | undefined): string {
  let full = source
  const hasProtocol = /^[a-z][\w+.-]*:/i.test(source)
  if (sourceRoot && !hasProtocol && !source.startsWith('/'))
    full = `${sourceRoot.replace(/\/+$/, '')}/${source}`
  full = full.replace(/^[a-z][\w+.-]*:\/*/i, '')
  const queryStart = full.indexOf('?')
  const query = queryStart === -1
    ? ''
    : full.slice(queryStart)
  const pathPart = queryStart === -1
    ? full
    : full.slice(0, queryStart)
  let segments = normalizeSegments(pathPart)
  if (segments.length === 0)
    segments = ['unnamed']
  segments = withQueryHash(segments, query)
  return ['sources', host, ...segments].join('/')
}

/**
 * Joins a relative path onto the session directory and refuses anything that would end up
 * outside it. The sanitisers above already prevent that; this is the last line of defence.
 */
export function safeJoin(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, relative)
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep))
    throw new SiteToApiError(`Refusing to write "${relative}" outside the session directory ${resolvedRoot}.`)
  return target
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Cleans a user-supplied session id so it is a single safe directory name.
 * Throws when nothing usable is left.
 */
export function sanitizeSessionId(id: string): string {
  const clean = id.trim().replaceAll(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100)
  if (clean === '')
    throw new SiteToApiError(`Session id "${id}" has no usable characters. Use letters, digits, ".", "-" or "_".`)
  return clean
}

/**
 * Default session id: `<host or 'blank'>-<yyyyMMdd-HHmmss>` in UTC, so ids sort by time and do
 * not depend on the machine's time zone.
 */
export function defaultSessionId(startUrl: string | null, now: Date): string {
  let host = 'blank'
  if (startUrl !== null) {
    try {
      host = new URL(startUrl).hostname || 'blank'
    }
    catch {
      host = 'blank'
    }
  }
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return sanitizeSessionId(`${host}-${stamp}`)
}
