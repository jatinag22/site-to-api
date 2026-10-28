/**
 * `build.json`: the options the last `build` ran with. `probe` rebuilds the folder and `gen`
 * rewrites the client, and neither takes `build`'s flags; without this record, `probe` after
 * `build --examples none` would rebuild with the config default and write masked examples. Holds
 * option values and host patterns only, never captured data, so it is safe to commit.
 */
import type { ConfigSource } from '../config/load'
import type { ResolvedConfig } from '../config/schema'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'

const BUILD_RECORD_FILE = 'build.json'

/** Options `probe` and `gen` can reuse, as dotted config paths. */
const STICKY_PATHS = [
  'gen.client',
  'hosts.exclude',
  'hosts.include',
  'redact.examples',
] as const
const BuildRecordSchema = z.strictObject({
  formatVersion: z.literal(1),
  generatedBy: z.string(),
  /** Effective values of the last build, whatever set them. */
  examples: z.enum(['masked', 'raw', 'none']),
  hosts: z.strictObject({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  client: z.boolean(),
  /**
   * The options above that came from CLI flags or `SITE_TO_API_*` variables. `probe` and `gen`
   * reuse exactly these; the others come from the config file, which they read again anyway.
   */
  sticky: z.array(z.enum(STICKY_PATHS)),
})
export type BuildRecord = z.infer<typeof BuildRecordSchema>

/** The record for a build with this config; `sources` says which values were given on the command line. */
export function buildRecordFor(config: ResolvedConfig, sources: Record<string, ConfigSource>, toolVersion: string): BuildRecord {
  return {
    formatVersion: 1,
    generatedBy: `site-to-api ${toolVersion}`,
    examples: config.redact.examples,
    hosts: {
      include: [...config.hosts.include],
      exclude: [...config.hosts.exclude],
    },
    client: config.gen.client,
    sticky: STICKY_PATHS.filter(path => sources[path] === 'flag' || sources[path] === 'env'),
  }
}

/** Writes `build.json` into the handoff folder. */
export async function writeBuildRecord(outDir: string, record: BuildRecord): Promise<string> {
  const path = join(outDir, BUILD_RECORD_FILE)
  await writeFile(path, `${JSON.stringify(BuildRecordSchema.parse(record), null, 2)}\n`)
  return path
}

/** Reads `build.json`; `null` when no build has written one yet. */
export async function readBuildRecord(outDir: string): Promise<BuildRecord | null> {
  const path = join(outDir, BUILD_RECORD_FILE)
  if (!existsSync(path))
    return null
  let data: unknown
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new SiteToApiError(`${path} is not valid JSON. Run \`site-to-api build\` to rewrite it.`, { cause: error })
  }
  const parsed = BuildRecordSchema.safeParse(data)
  if (!parsed.success)
    throw new SiteToApiError(`${path} is not a build record this version understands. Run \`site-to-api build\` to rewrite it.`)
  return parsed.data
}

/** Build options in the nested shape of config flags; absent keys were not sticky. */
export interface StickyOptions {
  hosts: { include?: string[], exclude?: string[] }
  redact: { examples?: BuildRecord['examples'] }
  gen: { client?: boolean }
  /** The same options as flags, for the log line (`--examples none`). */
  described: string[]
}

/** The options of the last build that `probe` and `gen` reuse unless their own flags override them. */
export function stickyOptions(record: BuildRecord | null): StickyOptions {
  const sticky = new Set(record?.sticky ?? [])
  const result: StickyOptions = {
    hosts: {},
    redact: {},
    gen: {},
    described: [],
  }
  if (!record)
    return result
  if (sticky.has('hosts.include')) {
    result.hosts.include = record.hosts.include
    result.described.push(record.hosts.include.map(pattern => `--include ${pattern}`).join(' ') || 'no --include')
  }
  if (sticky.has('hosts.exclude')) {
    result.hosts.exclude = record.hosts.exclude
    result.described.push(record.hosts.exclude.map(pattern => `--exclude ${pattern}`).join(' ') || 'no --exclude')
  }
  if (sticky.has('redact.examples')) {
    result.redact.examples = record.examples
    result.described.push(`--examples ${record.examples}`)
  }
  if (sticky.has('gen.client')) {
    result.gen.client = record.client
    result.described.push(record.client ? 'client on' : '--no-client')
  }
  return result
}

/**
 * After `gen`: the folder now has a current client, so a sticky `--no-client` no longer
 * describes it, and a later `probe` should keep the client up to date.
 */
export async function recordClientGenerated(outDir: string): Promise<void> {
  const record = await readBuildRecord(outDir)
  if (!record)
    return
  await writeBuildRecord(outDir, {
    ...record,
    client: true,
    sticky: record.sticky.filter(path => path !== 'gen.client'),
  })
}
