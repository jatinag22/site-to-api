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
import { join, relative, resolve } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'

const BUILD_RECORD_FILE = 'build.json'

/** The client folder relative to the handoff folder when `gen.clientDir` is not set. */
const DEFAULT_CLIENT_DIR = 'client'

/** Options `probe` reuses, as dotted config paths (`gen` only updates `gen.client`). */
const STICKY_PATHS = [
  'gen.client',
  'gen.mcp',
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
  /** `gen.mcp`; absent in records written before `client/mcp/` existed, which means `off`. */
  mcp: z.enum(['off', 'read', 'write']).optional(),
  /**
   * The files `gen` generated into the client folder, by path relative to it, and their SHA-256
   * (decision 0057): only these are replaced or removed later, and a changed hash means a hand
   * edit. Absent in older records.
   */
  generated: z.record(z.string(), z.string()).optional(),
  /**
   * The client folder relative to the handoff folder, with `/` separators (`client`, or
   * `../client` with `gen.clientDir`), so `gen` and `mcp` find it from the handoff folder alone.
   * Absent in older records, which means `client`.
   */
  clientDir: z.string().optional(),
  /**
   * The options above that came from CLI flags or `SITE_TO_API_*` variables. `probe` and `gen`
   * reuse exactly these; the others come from the config file, which they read again anyway.
   */
  sticky: z.array(z.enum(STICKY_PATHS)),
})
export type BuildRecord = z.infer<typeof BuildRecordSchema>

/** The record for a build with this config; `sources` says which values were given on the command line. */
export function buildRecordFor(config: ResolvedConfig, sources: Record<string, ConfigSource>, toolVersion: string, generated?: Record<string, string>, clientDir: string = DEFAULT_CLIENT_DIR): BuildRecord {
  return {
    ...(generated === undefined
      ? {}
      : { generated }),
    clientDir,
    formatVersion: 1,
    generatedBy: `site-to-api ${toolVersion}`,
    examples: config.redact.examples,
    hosts: {
      include: [...config.hosts.include],
      exclude: [...config.hosts.exclude],
    },
    client: config.gen.client,
    mcp: config.gen.mcp,
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
  gen: { client?: boolean, mcp?: NonNullable<BuildRecord['mcp']> }
  /** The same options as flags, for the log line (`--examples none`). */
  described: string[]
}

/**
 * The options of the last build that `probe` reuses. `current` holds where each value of the
 * config resolved now comes from; options set by an environment variable or flag are not reused.
 */
export function stickyOptions(record: BuildRecord | null, current: Record<string, ConfigSource> = {}): StickyOptions {
  // A value the user sets now (environment variable or flag) beats the one the last build used.
  const sticky = new Set((record?.sticky ?? []).filter(path => current[path] !== 'env' && current[path] !== 'flag'))
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
  if (sticky.has('gen.mcp')) {
    result.gen.mcp = record.mcp ?? 'off'
    result.described.push(`--mcp ${result.gen.mcp}`)
  }
  return result
}

/** What `gen` changed, for {@link recordClientGenerated}. */
export interface ClientUpdate {
  /** The MCP mode gen wrote, and whether a flag or variable chose it. */
  mcp?: { mode: NonNullable<BuildRecord['mcp']>, sticky: boolean }
  /** The manifest of generated files (decision 0057). */
  generated?: Record<string, string>
  /** The client folder relative to the handoff folder. */
  clientDir?: string
}

/**
 * After `gen`: the folder now has a current client, so a sticky `--no-client` no longer
 * describes it, and a later `probe` should keep the client up to date. `mcp` is what gen wrote
 * into `client/mcp/`; it is sticky when a flag or variable chose it, so probe's rebuild keeps it.
 */
export async function recordClientGenerated(outDir: string, update: ClientUpdate = {}): Promise<void> {
  const { mcp, generated, clientDir } = update
  const record = await readBuildRecord(outDir)
  if (!record)
    return
  const sticky = record.sticky.filter(path => path !== 'gen.client' && (mcp === undefined || path !== 'gen.mcp'))
  await writeBuildRecord(outDir, {
    ...record,
    ...(generated === undefined
      ? {}
      : { generated }),
    ...(clientDir === undefined
      ? {}
      : { clientDir }),
    client: true,
    ...(mcp === undefined
      ? {}
      : { mcp: mcp.mode }),
    sticky: mcp?.sticky === true
      ? [...sticky, 'gen.mcp' as const].sort()
      : sticky,
  })
}

/**
 * The client folder of the handoff folder `outDir`, as `build.json` records it (decision 0057);
 * `<outDir>/client` when no record or an older one says nothing.
 */
export function recordedClientDir(outDir: string, record: BuildRecord | null): string {
  return resolve(outDir, record?.clientDir ?? DEFAULT_CLIENT_DIR)
}

/**
 * The client folder for `config`, absolute: `gen.clientDir` resolved against `cwd`, or
 * `<outDir>/client`.
 */
export function configuredClientDir(config: ResolvedConfig, cwd: string): string {
  return config.gen.clientDir === null
    ? resolve(cwd, config.outDir, DEFAULT_CLIENT_DIR)
    : resolve(cwd, config.gen.clientDir)
}

/** `to` relative to `from` with `/` separators, as written into Markdown and `build.json`. */
export function relativePath(from: string, to: string): string {
  return relative(from, to) || '.'
}

/** The manifest of the last run for a client now in `clientDir`, and a warning when it moved. */
export interface PreviousClient {
  /** `null` for a folder from an older version without a manifest (decision 0057). */
  previous: Record<string, string> | null
  warning: string | null
}

/**
 * What the last run generated into `clientDir`. When `gen.clientDir` changed since, the recorded
 * files are in the old folder: the new folder starts with nothing generated, and the old one is
 * left for the person to delete.
 */
export function previousClient(outDir: string, record: BuildRecord | null, clientDir: string): PreviousClient {
  if (record === null)
    return { previous: null, warning: null }
  const recorded = recordedClientDir(outDir, record)
  if (recorded === clientDir)
    return { previous: record.generated ?? null, warning: null }
  return {
    previous: {},
    warning: existsSync(recorded)
      ? `The client moved from ${recorded} to ${clientDir} (gen.clientDir); the old folder was left as it is. Delete it once nothing imports it.`
      : null,
  }
}
