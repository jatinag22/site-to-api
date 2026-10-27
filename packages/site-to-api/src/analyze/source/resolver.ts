/**
 * Maps browser stack frames to the site's original source files through the sourcemaps the
 * capture saved, and picks the frame that represents the site's own call site.
 */
import type { TraceMap } from '@jridgewell/trace-mapping'
import type { LoadedSession, SessionMeta, SourceRef, SourceResolver, StackFrame } from '../../model'
import { AnyMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { z } from 'zod'
import { isLibraryPath, normalizeSourcePath, readSessionFile, urlPath } from './files'

type ScriptEntry = SessionMeta['scripts'][number]

/** Name of the script the capture step injects; its frames are never the site's code. */
const INSTRUMENT_SCRIPT = 'site-to-api-instrument.js'

const BROWSER_INTERNAL_URL = /^(?:native|<anonymous>|\[native code\]|(?:chrome|moz|safari|safari-web|ms-browser)-extension:|extensions::|chrome:|about:|node:|webpack-internal:\/\/\/\(webpack\))/i

/**
 * Functions inside well-known HTTP clients. Their frames sit between the site's call and the
 * network, so `callSite` steps over them even when they are bundled without a sourcemap.
 */
const HTTP_CLIENT_FUNCTIONS = new Set([
  // axios
  'dispatchXhrRequest',
  'xhrAdapter',
  'fetchAdapter',
  'httpAdapter',
  'dispatchRequest',
  'Axios.request',
  'Axios._request',
  'Axios.<computed>',
  'throwIfCancellationRequested',
  // fetch polyfills (whatwg-fetch, unfetch, cross-fetch, isomorphic-fetch)
  'fetchPolyfill',
  'unfetch',
  'crossFetch',
  // jQuery
  'jQuery.ajax',
  'jQuery.get',
  'jQuery.post',
  'jQuery.getJSON',
])

/** Bundle file names that only ever contain library code. */
const LIBRARY_BUNDLE = /(?:^|[/._~-])(?:jquery|axios|polyfills?|vendors?|framework|react-dom)(?:[._~-][\w.~-]*)?\.m?js$/i

/** The part of a sourcemap we rely on; anything else is left to trace-mapping. */
const SourceMapFileSchema = z.union([
  z.object({
    version: z.literal(3),
    mappings: z.string(),
    sources: z.array(z.string().nullable()),
  }),
  z.object({
    version: z.literal(3),
    sections: z.array(z.unknown()),
  }),
])

interface LoadedScript {
  script: ScriptEntry
  map: TraceMap | null
}

/** A {@link SourceResolver} plus the problems met while loading sourcemaps. */
export interface LoadedSourceResolver extends SourceResolver {
  /** Sourcemaps that were listed but missing or unreadable; frames in them resolve to the bundle. */
  warnings: string[]
}

function withoutHash(url: string): string {
  const index = url.indexOf('#')
  return index === -1
    ? url
    : url.slice(0, index)
}

async function loadMap(session: LoadedSession, script: ScriptEntry, warnings: string[]): Promise<TraceMap | null> {
  if (!script.sourceMap)
    return null
  const text = await readSessionFile(session, script.sourceMap.file)
  if (text === null) {
    warnings.push(`Sourcemap ${script.sourceMap.file} for ${script.url} is listed in session ${session.meta.sessionId} but missing; frames in it point at the bundle instead.`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    warnings.push(`Sourcemap ${script.sourceMap.file} in session ${session.meta.sessionId} is not valid JSON; frames in it point at the bundle instead.`)
    return null
  }
  if (!SourceMapFileSchema.safeParse(parsed).success) {
    warnings.push(`Sourcemap ${script.sourceMap.file} in session ${session.meta.sessionId} is not a version 3 sourcemap; frames in it point at the bundle instead.`)
    return null
  }
  try {
    // Built without a map URL so source names stay as the bundler wrote them (`webpack://app/src/x.ts`).
    return new AnyMap(text)
  }
  catch (error) {
    warnings.push(`Sourcemap ${script.sourceMap.file} in session ${session.meta.sessionId} could not be decoded (${error instanceof Error
      ? error.message
      : String(error)}); frames in it point at the bundle instead.`)
    return null
  }
}

function isBrowserInternal(url: string): boolean {
  return url.trim() === '' || BROWSER_INTERNAL_URL.test(url)
}

function isInstrumentation(url: string): boolean {
  return withoutHash(url).split('?')[0]?.endsWith(INSTRUMENT_SCRIPT) ?? false
}

function isHttpClientFunction(name: string | null): boolean {
  if (name === null)
    return false
  const bare = name.replace(/^(?:async |new )/, '').replace(/^Object\./, '')
  return HTTP_CLIENT_FUNCTIONS.has(bare)
}

/**
 * Loads every session's sourcemaps (`meta.scripts[].sourceMap.file`) and returns a resolver.
 * Missing or malformed maps are not fatal: frames in those scripts resolve to the bundle and the
 * problem is listed in `warnings`.
 */
export async function createSourceResolver(sessions: LoadedSession[]): Promise<LoadedSourceResolver> {
  const warnings: string[] = []
  const bySession = new Map<string, Map<string, LoadedScript>>()
  for (const session of sessions) {
    const scripts = new Map<string, LoadedScript>()
    for (const script of session.meta.scripts) {
      const key = withoutHash(script.url)
      if (scripts.has(key))
        continue
      scripts.set(key, { script, map: await loadMap(session, script, warnings) })
    }
    bySession.set(session.meta.sessionId, scripts)
  }

  const resolve = (frame: StackFrame, sessionId: string): SourceRef => {
    const bundleRef: SourceRef = {
      file: urlPath(frame.url),
      line: frame.line,
      column: frame.column,
      functionName: frame.functionName,
      original: false,
      excerpt: null,
    }
    const loaded = bySession.get(sessionId)?.get(withoutHash(frame.url))
    if (!loaded?.map)
      return bundleRef
    // V8 columns are 1-based, sourcemap columns 0-based.
    const position = originalPositionFor(loaded.map, {
      line: frame.line,
      column: Math.max(frame.column - 1, 0),
    })
    if (position.source === null)
      return bundleRef
    const file = normalizeSourcePath(position.source)
    if (file === '')
      return bundleRef
    return {
      file,
      line: position.line,
      column: position.column + 1,
      functionName: position.name ?? frame.functionName,
      original: true,
      excerpt: null,
    }
  }

  const callSite = (stack: StackFrame[], sessionId: string): SourceRef | null => {
    for (const frame of stack) {
      if (isInstrumentation(frame.url) || isBrowserInternal(frame.url))
        continue
      const ref = resolve(frame, sessionId)
      if (ref.original
        ? isLibraryPath(ref.file)
        : LIBRARY_BUNDLE.test(ref.file)) {
        continue
      }
      if (isHttpClientFunction(frame.functionName) || isHttpClientFunction(ref.functionName))
        continue
      return ref
    }
    return null
  }

  return { resolve, callSite, warnings }
}
