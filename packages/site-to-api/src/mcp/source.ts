/**
 * Where the MCP server gets its handoff folder from (decision 0043). The server starts before
 * the folder exists (a plugin enables it in every project), so the folder is read on the first
 * tool call, and read again whenever `build`, `probe` or `gen` rewrote it.
 */
import type { Handoff } from './handoff'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'pathe'
import { SiteToApiError } from '../errors'
import { loadHandoff } from './handoff'

/** The folder, or why there is none yet, as a message that says what to run. */
export type HandoffSource = () => Promise<Handoff | string>

/** Files every `build`, `probe` or `gen` rewrites: when one changes, the folder is read again. */
const WATCHED = [
  'flows.json',
  'build.json',
  join('client', 'index.ts'),
]

async function version(dir: string): Promise<string> {
  const times = await Promise.all(WATCHED.map(async (file) => {
    const path = join(dir, file)
    return existsSync(path)
      ? String((await stat(path)).mtimeMs)
      : '-'
  }))
  return times.join(':')
}

/**
 * Reads `dir` on demand. A missing folder, or one `build` has not finished writing, is a message,
 * not an error, so the server keeps running and the next call tries again.
 */
export function createHandoffSource(dir: string, log: (message: string) => void = () => {}): HandoffSource {
  let cached: { version: string, handoff: Handoff } | null = null
  return async () => {
    if (!existsSync(join(dir, 'flows.json')))
      return `No handoff folder at ${dir}: run \`site-to-api capture\` (browse the site), then \`site-to-api build\`. The next tool call picks the folder up; no restart needed.`
    const current = await version(dir)
    if (cached?.version === current)
      return cached.handoff
    try {
      const handoff = await loadHandoff(dir)
      for (const warning of handoff.warnings)
        log(warning)
      cached = { version: current, handoff }
      return handoff
    }
    catch (error) {
      if (error instanceof SiteToApiError)
        return error.message
      throw error
    }
  }
}
