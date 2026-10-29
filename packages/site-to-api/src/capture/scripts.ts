/**
 * Saves every script the pages load and, when one exists, its sourcemap and the original files
 * inside it. Missing or broken sourcemaps are normal on production sites, so every failure here
 * becomes a warning and capture carries on.
 */
import type { APIRequestContext, Response } from 'playwright'
import type { SessionMeta } from '../model'
import type { Lookup } from './network'
import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { cachedLookup, localPageOf, sourceMapRefusal } from './network'
import { hostDir, safeJoin, scriptFilePath, sourceFilePath, sourceMapFilePath } from './paths'
import { WarningLog } from './warnings'

type ScriptRecord = SessionMeta['scripts'][number]

/**
 * Analytics, ads and tag-manager hosts. Their bundles are large, change constantly and never
 * contain the site's own API calls, so saving them only slows capture down.
 */
const SKIPPED_SCRIPT_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
  'adservice.google.com',
  'connect.facebook.net',
  'facebook.net',
  'hotjar.com',
  'clarity.ms',
  'cdn.segment.com',
  'cdn.mxpnl.com',
  'cdn.amplitude.com',
  'js-agent.newrelic.com',
  'static.ads-twitter.com',
  'snap.licdn.com',
  'bat.bing.com',
  'analytics.tiktok.com',
  'cdn.taboola.com',
  'criteo.net',
  'adnxs.com',
]

const SOURCEMAP_TIMEOUT_MS = 8000
/** Redirects followed by hand, so each hop goes through the same address check as the first. */
const SOURCEMAP_MAX_REDIRECTS = 3

/** Label stored as the sourcemap URL when the map was embedded in the script as a `data:` URI. */
const INLINE_SOURCEMAP_URL = 'inline'

/** True for hosts on the built-in analytics and ads list, including their subdomains. */
export function isSkippedScriptHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return SKIPPED_SCRIPT_HOSTS.some(skip => host === skip || host.endsWith(`.${skip}`))
}

const SourceMapSchema = z.looseObject({
  version: z.union([
    z.number(),
    z.string(),
  ]),
  sources: z.array(z.string().nullable()),
  sourcesContent: z.array(z.string().nullable()).optional(),
  sourceRoot: z.string().nullable().optional(),
})
type SourceMapJson = z.infer<typeof SourceMapSchema>

/** A place a sourcemap may be found, in the order they are tried. */
export type SourceMapCandidate
  = | { kind: 'url', url: string, /** `<url>.map` guess rather than an explicit reference. */ guess: boolean }
    | { kind: 'inline', text: string }

const COMMENT = /\/[*/][#@]\s*sourceMappingURL=([^\s*'"]+)/g

/** Decodes a `data:` URI into text, or `null` when it is malformed. */
export function decodeDataUri(uri: string): string | null {
  const comma = uri.indexOf(',')
  if (!uri.startsWith('data:') || comma === -1)
    return null
  const header = uri.slice(5, comma)
  const data = uri.slice(comma + 1)
  try {
    if (header.split(';').includes('base64'))
      return Buffer.from(data, 'base64').toString('utf8')
    return decodeURIComponent(data)
  }
  catch {
    return null
  }
}

/**
 * Lists where a script's sourcemap may be: the `SourceMap`/`X-SourceMap` header, the last
 * `sourceMappingURL` comment (which may be an inline `data:` URI), and finally `<url>.map`.
 * Relative references resolve against the script URL. Duplicates are removed.
 */
export function sourceMapCandidates(scriptUrl: string, headers: Record<string, string>, body: string): SourceMapCandidate[] {
  const out: SourceMapCandidate[] = []
  const seen = new Set<string>()
  const addUrl = (ref: string, guess: boolean): void => {
    let url: string
    try {
      url = new URL(ref, scriptUrl).href
    }
    catch {
      return
    }
    if (!/^https?:/.test(url) || seen.has(url))
      return
    seen.add(url)
    out.push({ kind: 'url', url, guess })
  }
  const header = headers.sourcemap ?? headers['x-sourcemap']
  if (header)
    addUrl(header.trim(), false)
  // Only the tail can hold the comment that applies; scanning a few MB of bundle is wasteful.
  let last: string | undefined
  for (const match of body.slice(-200_000).matchAll(COMMENT))
    last = match[1]
  if (last !== undefined) {
    if (last.startsWith('data:')) {
      const text = decodeDataUri(last)
      if (text !== null)
        out.push({ kind: 'inline', text })
    }
    else {
      addUrl(last, false)
    }
  }
  const base = new URL(scriptUrl)
  base.search = ''
  base.hash = ''
  addUrl(`${base.href}.map`, true)
  return out
}

/** Parses sourcemap text; only maps with `version` and `sources` are accepted. */
export function parseSourceMap(text: string): SourceMapJson | null {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, ''))
  }
  catch {
    return null
  }
  const parsed = SourceMapSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Writes a file inside the session directory, creating parent directories. */
async function writeInside(sessionDir: string, relative: string, data: string | Buffer): Promise<void> {
  const target = safeJoin(sessionDir, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, data)
}

/** Where a script came from, for deciding which sourcemap URLs may be fetched. */
interface ScriptOrigin {
  url: URL
  /** The page that loaded the script, when it is on a non-public host (a dev server, an intranet app). */
  localPage: URL | null
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

/** URL of the top frame that loaded a script, or `null` for worker scripts and closed pages. */
function pageUrlOf(response: Response): string | null {
  try {
    return response.frame().page().mainFrame().url()
  }
  catch {
    return null
  }
}

interface FoundMap {
  url: string
  text: string
  map: SourceMapJson
}

/** Collects scripts and sourcemaps for one session. */
export class ScriptCollector {
  private readonly seen = new Set<string>()
  private readonly pending = new Set<Promise<void>>()
  readonly scripts: ScriptRecord[] = []
  private readonly log = new WarningLog()
  private readonly lookup: Lookup

  constructor(
    private readonly sessionDir: string,
    private readonly request: APIRequestContext,
    private readonly options: { saveScripts: boolean, sourcemaps: boolean, /** Replaces DNS in tests. */ lookup?: Lookup },
  ) {
    this.lookup = cachedLookup(options.lookup)
  }

  /** Warnings so far: one-off problems, then one line per kind of repeated sourcemap problem. */
  get warnings(): string[] {
    return this.log.list()
  }

  private warn(message: string): void {
    this.log.add(message)
  }

  private warnGrouped(key: string, url: string, single: string, summary: (count: number, first: string) => string): void {
    this.log.addGrouped(key, url, single, summary)
  }

  /** Starts processing a response if it is a script worth keeping. */
  onResponse(response: Response): void {
    if (response.request().resourceType() !== 'script')
      return
    const url = response.url()
    let parsed: URL
    try {
      parsed = new URL(url)
    }
    catch {
      return
    }
    if (!/^https?:$/.test(parsed.protocol) || isSkippedScriptHost(parsed.hostname) || this.seen.has(url))
      return
    this.seen.add(url)
    const task = this.process(response, parsed).catch((error: unknown) => {
      this.warn(`Could not save script ${url}: ${error instanceof Error
        ? error.message
        : String(error)}`)
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  /** Waits until every script seen so far, and any started meanwhile, has been processed. */
  async settle(): Promise<void> {
    while (this.pending.size > 0)
      await Promise.all(this.pending)
  }

  private async process(response: Response, url: URL): Promise<void> {
    if (response.status() >= 400)
      return
    const body = (await response.body()).toString('utf8')
    const file = scriptFilePath(url.href)
    if (this.options.saveScripts)
      await writeInside(this.sessionDir, file, body)
    let sourceMap: ScriptRecord['sourceMap'] = null
    if (this.options.sourcemaps) {
      const origin = { url, localPage: await this.localPage(pageUrlOf(response)) }
      const found = await this.findSourceMap(origin, response.headers(), body)
      if (found)
        sourceMap = await this.saveSourceMap(url, file, found)
    }
    // Without saved bundles there is no file to point at; the sourcemap is still useful.
    if (this.options.saveScripts || sourceMap) {
      this.scripts.push({
        url: url.href,
        file: this.options.saveScripts ? file : '',
        sourceMap,
      })
    }
  }

  /** The page URL when the page is on a non-public host (see {@link localPageOf}). */
  private async localPage(pageUrl: string | null): Promise<URL | null> {
    return await localPageOf(pageUrl, this.lookup)
  }

  private async findSourceMap(script: ScriptOrigin, headers: Record<string, string>, body: string): Promise<FoundMap | null> {
    const scriptUrl = script.url.href
    for (const candidate of sourceMapCandidates(scriptUrl, headers, body)) {
      if (candidate.kind === 'inline') {
        const map = parseSourceMap(candidate.text)
        if (map)
          return { url: INLINE_SOURCEMAP_URL, text: candidate.text, map }
        this.warn(`Inline sourcemap in ${scriptUrl} is not a valid sourcemap.`)
        continue
      }
      const text = await this.fetchText(candidate.url, script, !candidate.guess)
      if (text === null)
        continue
      const map = parseSourceMap(text)
      if (map)
        return { url: candidate.url, text, map }
      if (!candidate.guess) {
        this.warnGrouped('invalid-json', candidate.url, `Sourcemap ${candidate.url} for ${scriptUrl} is not valid sourcemap JSON.`, (count, first) =>
          `${count} sourcemaps are not valid sourcemap JSON (first: ${first}); stack frames in those scripts point at the bundles.`)
      }
    }
    return null
  }

  /**
   * Fetches with the browser's cookies, following redirects by hand so every hop is checked by
   * {@link sourceMapRefusal}. A refused URL is always a warning; other misses on the `<url>.map`
   * guess are expected and silent.
   */
  private async fetchText(url: string, script: ScriptOrigin, warnOnFailure: boolean): Promise<string | null> {
    let current = url
    try {
      for (let hop = 0; hop <= SOURCEMAP_MAX_REDIRECTS; hop++) {
        const refusal = await sourceMapRefusal(new URL(current), script.url, script.localPage, this.lookup)
        if (refusal !== null) {
          // One line per URL: a refusal is a security decision worth reading in full.
          this.warn(`Did not fetch sourcemap ${current} for ${script.url.href}: ${refusal}.`)
          return null
        }
        const response = await this.request.get(current, { timeout: SOURCEMAP_TIMEOUT_MS, failOnStatusCode: false, maxRedirects: 0 })
        const status = response.status()
        const location = response.headers().location
        if (status >= 300 && status < 400 && location !== undefined) {
          await response.dispose()
          current = new URL(location, current).href
          continue
        }
        if (!response.ok()) {
          if (warnOnFailure) {
            this.warnGrouped(`http:${status}`, current, `Sourcemap ${current} returned HTTP ${status}.`, (count, first) =>
              `${count} sourcemaps returned HTTP ${status} (first: ${first}).`)
          }
          await response.dispose()
          return null
        }
        const text = await response.text()
        await response.dispose()
        return text
      }
      if (warnOnFailure)
        this.warn(`Sourcemap ${url} redirected more than ${SOURCEMAP_MAX_REDIRECTS} times.`)
      return null
    }
    catch (error) {
      if (warnOnFailure)
        this.warn(`Could not fetch sourcemap ${current}: ${errorText(error)}`)
      return null
    }
  }

  private async saveSourceMap(scriptUrl: URL, scriptFile: string, found: FoundMap): Promise<NonNullable<ScriptRecord['sourceMap']>> {
    const mapFile = sourceMapFilePath(scriptFile)
    await writeInside(this.sessionDir, mapFile, found.text)
    const host = hostDir(scriptUrl)
    const sources: string[] = []
    const contents = found.map.sourcesContent ?? []
    for (const [index, source] of found.map.sources.entries()) {
      const content = contents[index]
      if (source === null || typeof content !== 'string')
        continue
      const file = sourceFilePath(host, source, found.map.sourceRoot ?? undefined)
      try {
        await writeInside(this.sessionDir, file, content)
        if (!sources.includes(file))
          sources.push(file)
      }
      catch (error) {
        this.warn(`Could not unpack ${source} from ${found.url}: ${error instanceof Error
          ? error.message
          : String(error)}`)
      }
    }
    return { url: found.url, file: mapFile, sources }
  }
}
