/**
 * Loads configuration from defaults, a config file, environment variables and CLI flags, in that
 * order of increasing precedence (decision 0006), and records where each value came from.
 */
import type { ResolvedConfig } from './schema'
import { existsSync } from 'node:fs'
import { createJiti } from 'jiti'
import { resolve } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'
import { ConfigSchema } from './schema'

const CONFIG_FILE_NAMES: readonly string[] = [
  'site-to-api.config.ts',
  'site-to-api.config.mts',
  'site-to-api.config.js',
  'site-to-api.config.mjs',
  'site-to-api.config.json',
]

const ENV_PREFIX = 'SITE_TO_API_'

export type ConfigSource = 'default' | 'file' | 'env' | 'flag'

export interface LoadedConfig {
  config: ResolvedConfig
  /** Config file used, or `null` when none was found. */
  file: string | null
  /** Where each leaf value came from, keyed by dotted path (`redact.examples`). */
  sources: Record<string, ConfigSource>
}

export interface LoadConfigOptions {
  cwd: string
  /** Explicit config file path (`--config`). */
  configFile?: string | null
  env?: Record<string, string | undefined>
  /** Values from CLI flags, already nested (`{ redact: { examples: 'raw' } }`). */
  flags?: Record<string, unknown>
}

type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deep merge where later layers win; arrays and primitives replace. */
function merge(base: PlainObject, override: PlainObject): PlainObject {
  const result: PlainObject = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined)
      continue
    const existing = result[key]
    result[key] = isPlainObject(existing) && isPlainObject(value)
      ? merge(existing, value)
      : value
  }
  return result
}

/** Dotted paths of every set leaf. `undefined` means "not given" (an unused CLI flag), so it is skipped. */
function leafPaths(value: PlainObject, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    if (child === undefined)
      return []
    const path = prefix
      ? `${prefix}.${key}`
      : key
    return isPlainObject(child)
      ? leafPaths(child, path)
      : [path]
  })
}

function camelCase(segment: string): string {
  return segment.toLowerCase().replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}

function parseEnvValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

/**
 * Turns `SITE_TO_API_REDACT__EXAMPLES=raw` into `{ redact: { examples: 'raw' } }`.
 * `__` separates nesting levels; single `_` separates words within a key.
 */
export function configFromEnv(env: Record<string, string | undefined>): PlainObject {
  let result: PlainObject = {}
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || raw === undefined || raw === '')
      continue
    const path = name.slice(ENV_PREFIX.length).split('__').map(camelCase)
    const nested = path.reduceRight<unknown>((child, key) => ({ [key]: child }), parseEnvValue(raw))
    if (isPlainObject(nested))
      result = merge(result, nested)
  }
  return result
}

function findConfigFile(cwd: string, explicit: string | null | undefined): string | null {
  if (explicit) {
    const path = resolve(cwd, explicit)
    if (!existsSync(path))
      throw new SiteToApiError(`Config file not found: ${path}`)
    return path
  }
  for (const name of CONFIG_FILE_NAMES) {
    const path = resolve(cwd, name)
    if (existsSync(path))
      return path
  }
  return null
}

async function readConfigFile(path: string): Promise<PlainObject> {
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false })
  let loaded: unknown
  try {
    loaded = await jiti.import(path, { default: true })
  }
  catch (error) {
    throw new SiteToApiError(`Could not load config file ${path}: ${error instanceof Error
      ? error.message
      : String(error)}`, { cause: error })
  }
  if (!isPlainObject(loaded))
    throw new SiteToApiError(`Config file ${path} must export an object (use \`export default defineConfig({ ... })\`).`)
  return loaded
}

/** Resolves the configuration for one command run. */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const file = findConfigFile(options.cwd, options.configFile)
  const fromFile = file
    ? await readConfigFile(file)
    : {}
  const fromEnv = configFromEnv(options.env ?? {})
  const fromFlags = options.flags ?? {}

  const merged = merge(merge(fromFile, fromEnv), fromFlags)
  const parsed = ConfigSchema.safeParse(merged)
  if (!parsed.success) {
    throw new SiteToApiError(`Invalid configuration:\n${z.prettifyError(parsed.error)}\nSources: ${file ?? 'no config file'}, ${ENV_PREFIX}* environment variables, CLI flags.`)
  }

  const sources: Record<string, ConfigSource> = {}
  for (const path of leafPaths(parsed.data))
    sources[path] = 'default'
  for (const [layer, values] of [
    ['file', fromFile],
    ['env', fromEnv],
    ['flag', fromFlags],
  ] as const) {
    for (const path of leafPaths(values))
      sources[path] = layer
  }

  return { config: parsed.data, file, sources }
}
