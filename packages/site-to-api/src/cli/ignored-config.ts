/**
 * What a code config file that `mcp` did not run would have changed (decision 0043: `mcp` never
 * runs project code). The file is read as text, never executed: a key `mcp` uses, set to a
 * literal that differs from the value in effect, or set to anything that is not a literal, is
 * reported. A config that only repeats the defaults (as `init` writes it) changes nothing.
 */
import type { ResolvedConfig } from '../config/schema'

type McpKeys = Pick<ResolvedConfig, 'outDir'> & { probe: Pick<ResolvedConfig['probe'], 'maxRps' | 'timeoutMs'> }

/** A key's value as written: a quoted string or a number literal, else null (an expression). */
function literal(text: string, key: string): { found: boolean, value: string | null } {
  const match = new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`).exec(text)
  if (match === null)
    return { found: false, value: null }
  const raw = (match[1] ?? '').trim()
  const quoted = /^(['"`])([^'"`$]*)\1$/.exec(raw)
  if (quoted !== null)
    return { found: true, value: quoted[2] ?? '' }
  return /^[\d_.]+$/.test(raw)
    ? {
        found: true,
        value: String(Number(raw.replaceAll('_', ''))),
      }
    : { found: true, value: null }
}

/** The keys of `mcp`'s settings that the unread config file sets to something else, sorted. */
export function ignoredConfigChanges(text: string, config: McpKeys): string[] {
  const keys: Array<[string, string]> = [
    ['outDir', config.outDir],
    [
      'maxRps',
      String(config.probe.maxRps),
    ],
    [
      'timeoutMs',
      String(config.probe.timeoutMs),
    ],
  ]
  return keys.flatMap(([key, current]) => {
    const written = literal(text, key)
    return written.found && written.value !== current
      ? [key]
      : []
  })
}
