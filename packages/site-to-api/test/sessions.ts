/**
 * Builds raw capture sessions on disk for tests of stages that read saved scripts, sourcemaps and
 * unpacked sources (`analyze/source`). Each call writes into a fresh temporary directory.
 */
import type { LoadedSession, SessionMeta } from '../src/model'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RAW_FORMAT_VERSION } from '../src/model'

export interface ScriptInit {
  url: string
  /** Saved bundle path relative to the session directory, and its content. */
  file: string
  content: string
  sourceMap?: {
    url: string
    file: string
    /** The map itself (serialised as JSON unless already a string). */
    map: unknown
    /** Unpacked originals: path relative to the session directory → content. */
    sources: Record<string, string>
  }
}

const created: string[] = []

/** Deletes every directory {@link writeSession} created; call it from `afterAll`. */
export async function removeSessions(): Promise<void> {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}

/** Writes the scripts of one session and returns it as `load` would. */
export async function writeSession(sessionId: string, scripts: ScriptInit[]): Promise<LoadedSession> {
  const dir = await mkdtemp(join(tmpdir(), `site-to-api-${sessionId}-`))
  created.push(dir)
  const put = async (file: string, content: string): Promise<void> => {
    const path = join(dir, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  const entries: SessionMeta['scripts'] = []
  for (const script of scripts) {
    await put(script.file, script.content)
    let sourceMap: SessionMeta['scripts'][number]['sourceMap'] = null
    if (script.sourceMap) {
      const { map, sources } = script.sourceMap
      await put(script.sourceMap.file, typeof map === 'string'
        ? map
        : JSON.stringify(map))
      for (const [file, content] of Object.entries(sources))
        await put(file, content)
      sourceMap = {
        url: script.sourceMap.url,
        file: script.sourceMap.file,
        sources: Object.keys(sources),
      }
    }
    entries.push({ url: script.url, file: script.file, sourceMap })
  }
  const meta: SessionMeta = {
    formatVersion: RAW_FORMAT_VERSION,
    sessionId,
    toolVersion: '0.0.0-test',
    startUrl: 'https://shop.test/',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    browser: { channel: null, headless: true, userAgent: 'test' },
    har: 'traffic.har',
    events: 'events.jsonl',
    scripts: entries,
  }
  await put('meta.json', JSON.stringify(meta))
  return { meta, dir, events: [] }
}
