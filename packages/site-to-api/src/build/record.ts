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
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'
import { isFolderRelative } from '../gen/contained'

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
/** A recorded generated file: relative and inside its folder, never `../…` or absolute (decision 0058). */
const ManifestKey = z.string().refine(isFolderRelative, { message: 'a generated file must be a relative path inside its folder' })

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
  /** `gen.mcp`; absent in records written before `mcp/` existed, which means `off`. */
  mcp: z.enum(['off', 'read', 'write']).optional(),
  /**
   * The files `gen` generated into the client folder, by path relative to it, and their SHA-256
   * (decision 0058): only these are replaced or removed later, and a changed hash means a hand
   * edit. Absent in older records.
   */
  generated: z.record(ManifestKey, z.string()).optional(),
  /**
   * The client folder relative to the handoff folder, with `/` separators (`client`, or
   * `../client` with `gen.clientDir`), so `gen` and `mcp` find it from the handoff folder alone.
   * Absent in older records, which means `client`.
   */
  clientDir: z.string().optional(),
  /** The MCP server folder relative to the handoff folder; absent: `mcp` next to the client folder. */
  mcpDir: z.string().optional(),
  /** The files `gen --mcp` generated into the MCP folder and their SHA-256, like `generated`. */
  generatedMcp: z.record(ManifestKey, z.string()).optional(),
  /**
   * The options above that came from CLI flags or `SITE_TO_API_*` variables. `probe` and `gen`
   * reuse exactly these; the others come from the config file, which they read again anyway.
   */
  sticky: z.array(z.enum(STICKY_PATHS)),
})
export type BuildRecord = z.infer<typeof BuildRecordSchema>

/** Where the client and MCP server are and which files were generated there (decision 0058). */
export interface RecordedClient {
  generated?: Record<string, string>
  generatedMcp?: Record<string, string>
  /** Relative to the handoff folder. */
  clientDir?: string
  /** Relative to the handoff folder. */
  mcpDir?: string
}

/** The record for a build with this config; `sources` says which values were given on the command line. */
export function buildRecordFor(config: ResolvedConfig, sources: Record<string, ConfigSource>, toolVersion: string, client: RecordedClient = {}): BuildRecord {
  const { generated, generatedMcp, clientDir = DEFAULT_CLIENT_DIR, mcpDir } = client
  return {
    ...(generated === undefined
      ? {}
      : { generated }),
    ...(generatedMcp === undefined
      ? {}
      : { generatedMcp }),
    clientDir,
    ...(mcpDir === undefined
      ? {}
      : { mcpDir }),
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
    throw new SiteToApiError(`${path} is not a build record this version understands (${z.prettifyError(parsed.error).replaceAll('\n', '; ')}). Run \`site-to-api build\` to rewrite it.`)
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
export interface ClientUpdate extends RecordedClient {
  /** The MCP mode gen wrote, and whether a flag or variable chose it. */
  mcp?: { mode: NonNullable<BuildRecord['mcp']>, sticky: boolean }
}

/**
 * After `gen`: the folder now has a current client, so a sticky `--no-client` no longer
 * describes it, and a later `probe` should keep the client up to date. `mcp` is what gen wrote
 * into `mcp/`; it is sticky when a flag or variable chose it, so probe's rebuild keeps it.
 */
export async function recordClientGenerated(outDir: string, update: ClientUpdate = {}): Promise<void> {
  const { mcp, generated, generatedMcp, clientDir, mcpDir } = update
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
    ...(generatedMcp === undefined
      ? {}
      : { generatedMcp }),
    ...(mcpDir === undefined
      ? {}
      : { mcpDir }),
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
 * The client folder of the handoff folder `outDir`, as `build.json` records it (decision 0058);
 * `<outDir>/client` when no record or an older one says nothing.
 */
export function recordedClientDir(outDir: string, record: BuildRecord | null): string {
  return resolve(outDir, record?.clientDir ?? DEFAULT_CLIENT_DIR)
}

/** The MCP server folder of the handoff folder `outDir`, as `build.json` records it. */
export function recordedMcpDir(outDir: string, record: BuildRecord | null): string {
  return record?.mcpDir === undefined
    ? join(dirname(recordedClientDir(outDir, record)), 'mcp')
    : resolve(outDir, record.mcpDir)
}

/** The MCP server folder for `config`, absolute: `gen.mcpDir`, or `mcp/` next to the client folder. */
export function configuredMcpDir(config: ResolvedConfig, cwd: string): string {
  return config.gen.mcpDir === null
    ? join(dirname(configuredClientDir(config, cwd)), 'mcp')
    : resolve(cwd, config.gen.mcpDir)
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

/** `dir` relative to the project folder `root` when inside it, as the CLI shows paths; else as it is. */
function fromRoot(root: string, dir: string): string {
  const shown = relative(root, dir)
  return shown === '' || shown.startsWith('..') || isAbsolute(shown)
    ? dir
    : shown
}

/** The manifest of the last run for a client now in `clientDir`, and a warning when it moved. */
export interface PreviousClient {
  /** `null` for a folder from an older version without a manifest (decision 0058). */
  previous: Record<string, string> | null
  warning: string | null
}

/**
 * What the last run generated into `clientDir`. When `gen.clientDir` changed since, the recorded
 * files are in the old folder: the new folder starts with nothing generated, and the old one is
 * left for the person to delete. The warning shows both folders relative to the project `root`.
 */
export function previousClient(outDir: string, record: BuildRecord | null, clientDir: string, root: string): PreviousClient {
  if (record === null)
    return { previous: null, warning: null }
  const recorded = recordedClientDir(outDir, record)
  if (recorded === clientDir)
    return { previous: record.generated ?? null, warning: null }
  return {
    previous: {},
    warning: existsSync(recorded)
      ? `The client moved from ${fromRoot(root, recorded)} to ${fromRoot(root, clientDir)} (gen.clientDir); the old folder was left as it is. Delete it once nothing imports it.`
      : null,
  }
}

/**
 * What the last run generated into the MCP folder `mcpDir`: nothing when no record lists it or
 * the folder moved, so files found there are not overwritten.
 */
export function previousMcp(outDir: string, record: BuildRecord | null, mcpDir: string): Record<string, string> {
  if (record === null || recordedMcpDir(outDir, record) !== mcpDir)
    return {}
  return record.generatedMcp ?? {}
}

/** The `gen.mcp` a build uses, and why. */
export interface McpChoice {
  mode: NonNullable<BuildRecord['mcp']>
  /** True when the mode is the last run's, kept because nothing set `gen.mcp` this time. */
  kept: boolean
}

/**
 * `gen.mcp` for this build. A server `gen --mcp` wrote stays across plain builds: when no config
 * file, variable or flag sets `gen.mcp`, the last run's mode is kept instead of the default `off`,
 * which would delete it (decision 0058). Setting `gen.mcp` (`--mcp off`) still removes it.
 */
export function mcpChoice(config: ResolvedConfig, sources: Record<string, ConfigSource> | undefined, record: BuildRecord | null): McpChoice {
  const unset = (sources?.['gen.mcp'] ?? 'default') === 'default'
  const last = record?.mcp ?? 'off'
  if (unset && last !== 'off' && Object.keys(record?.generatedMcp ?? {}).length > 0)
    return { mode: last, kept: true }
  return { mode: config.gen.mcp, kept: false }
}
