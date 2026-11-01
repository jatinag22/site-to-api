/**
 * Configuration error messages that say where the bad value came from (CLI flag, environment
 * variable or config file), suggest the key that was meant, and show the line of a config file
 * that does not parse.
 */
import type { z } from 'zod'
import { ConfigSchema } from './schema'

const ENV_PREFIX = 'SITE_TO_API_'

type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function at(root: unknown, path: readonly string[]): unknown {
  let node = root
  for (const key of path) {
    if (!isPlainObject(node))
      return undefined
    node = Object.entries(node).find(([name]) => name === key)?.[1]
  }
  return node
}

/** The layers a configuration is merged from, highest precedence last. */
export interface ConfigLayers {
  file: string | null
  fromFile: PlainObject
  fromEnv: PlainObject
  fromFlags: PlainObject
  env: Record<string, string | undefined>
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
}

function envSegment(key: string): string {
  return key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()
}

/** The variable name for a config path, as `configFromEnv` reads it back. */
export function envName(path: readonly string[]): string {
  return `${ENV_PREFIX}${path.map(envSegment).join('__')}`
}

/** The environment variable that set `path`: matched the way `configFromEnv` maps names. */
function envVariable(path: readonly string[], env: Record<string, string | undefined>): string {
  const wanted = path.join('.').toLowerCase().replaceAll('_', '')
  const found = Object.keys(env).find(name => name.startsWith(ENV_PREFIX)
    && name.slice(ENV_PREFIX.length).split('__').join('.').toLowerCase().replaceAll('_', '') === wanted)
  return found ?? envName(path)
}

/** Where the value at `path` came from: the highest layer that has it. */
export function sourceOf(path: readonly string[], layers: ConfigLayers): string {
  if (at(layers.fromFlags, path) !== undefined)
    return `CLI flag --${kebab(path.at(-1) ?? '')}`
  if (at(layers.fromEnv, path) !== undefined)
    return `environment variable ${envVariable(path, layers.env)}`
  return layers.file === null
    ? 'defaults'
    : `config file ${layers.file}`
}

/** Edit distance, for suggesting the key that was meant. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1]
          ? 0
          : 1),
      )
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

const DEFAULTS: unknown = ConfigSchema.parse({})

/** The known key closest to `key` at `parent`, or null when none is close. */
export function closestKey(parent: readonly string[], key: string): string | null {
  const known = at(DEFAULTS, parent)
  if (!isPlainObject(known))
    return null
  const plain = (value: string): string => value.toLowerCase().replace(/[-_]/g, '')
  let best: { key: string, score: number } | null = null
  for (const candidate of Object.keys(known)) {
    const score = distance(plain(key), plain(candidate))
    if (best === null || score < best.score)
      best = { key: candidate, score }
  }
  return best !== null && best.score <= Math.max(2, Math.floor(key.length / 3))
    ? best.key
    : null
}

function suggestion(parent: readonly string[], key: string, source: string): string {
  const meant = closestKey(parent, key)
  if (meant === null)
    return ''
  const path = [...parent, meant]
  if (source.startsWith('environment'))
    return ` Did you mean ${envName(path)}?`
  if (source.startsWith('CLI'))
    return ` Did you mean --${kebab(meant)}?`
  return ` Did you mean "${path.join('.')}"?`
}

/** One line per problem: the key, where it came from, what is wrong and, for a typo, the fix. */
export function describeIssues(issues: readonly z.core.$ZodIssue[], layers: ConfigLayers): string[] {
  return issues.flatMap((issue) => {
    const parent = issue.path.map(String)
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => {
        const source = sourceOf([...parent, key], layers)
        return `${[...parent, key].join('.')} (${source}): unknown key.${suggestion(parent, key, source)}`
      })
    }
    return [`${parent.join('.') || '(root)'} (${sourceOf(parent, layers)}): ${issue.message}`]
  })
}

/**
 * The 1-based line and 0-based column a parse error names: `line 2 column 24` (Node's JSON.parse,
 * 1-based column) or `file:3:2` (jiti's Babel parser, 0-based column).
 */
function errorLocation(message: string): { line: number, column: number } | null {
  const json = /line (\d+) column (\d+)/.exec(message)
  if (json !== null) {
    return {
      line: Number(json[1]),
      column: Number(json[2]) - 1,
    }
  }
  const code = /:(\d+):(\d+)\s*$/m.exec(message)
  return code === null
    ? null
    : {
        line: Number(code[1]),
        column: Number(code[2]),
      }
}

/**
 * The lines around a parse error with a caret under its column, or '' when the message names no
 * location. Two lines are shown: a missing comma is reported on the line after it.
 */
export function syntaxExcerpt(source: string, message: string): string {
  const location = errorLocation(message)
  if (location === null)
    return ''
  const lines = source.split(/\r?\n/)
  const target = lines[location.line - 1]
  if (target === undefined)
    return ''
  const width = String(location.line).length
  const row = (number: number, text: string): string => `  ${String(number).padStart(width)} | ${text}`
  const previous = location.line >= 2
    ? [
        row(location.line - 1, lines[location.line - 2] ?? ''),
      ]
    : []
  return [
    ...previous,
    row(location.line, target),
    `  ${' '.repeat(width)} | ${' '.repeat(Math.max(0, location.column))}^`,
  ].join('\n')
}
