/**
 * What a code config file that `mcp` did not run would have changed (decision 0043: `mcp` never
 * runs project code). The file is read as text, never executed: a key `mcp` uses, set to a
 * literal that differs from the value in effect, or set to anything that is not a literal, is
 * reported. A config that only repeats the defaults (as `init` writes it) changes nothing.
 */
import type { ResolvedConfig } from '../config/schema'

type McpKeys = Pick<ResolvedConfig, 'outDir'> & { probe: Pick<ResolvedConfig['probe'], 'maxRps' | 'timeoutMs'> }

/**
 * Comments, strings, `key:` and braces, in order. Comments and strings are matched whole first, so
 * a key inside them (`// outDir: 'x'`, `'https://…'`) is never read as one.
 */
const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|(['"`])(?:\\.|(?!\1)[^\\])*\1|([A-Z_$][\w$]*)\s*:|[{}]/gi

/** Each `key:` outside comments and strings, with its object path and where its value starts. */
function keys(text: string): Array<{ path: string, valueAt: number }> {
  const found: Array<{ path: string, valueAt: number }> = []
  const stack: string[] = []
  let pending = ''
  for (const match of text.matchAll(TOKEN)) {
    const [token, , key] = match
    if (token === '{') {
      stack.push(pending)
      pending = ''
    }
    else if (token === '}') {
      stack.pop()
      pending = ''
    }
    else if (key !== undefined) {
      found.push({
        path: [
          ...stack.filter(name => name !== ''),
          key,
        ].join('.'),
        valueAt: (match.index ?? 0) + token.length,
      })
      pending = key
    }
  }
  return found
}

/** The value written for `path`: a quoted string or a number literal, else null (an expression). */
function literal(text: string, path: string): { found: boolean, value: string | null } {
  const at = keys(text).find(entry => entry.path === path)
  if (at === undefined)
    return { found: false, value: null }
  const raw = (/^[^,}\n]*/.exec(text.slice(at.valueAt))?.[0] ?? '').trim()
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
  const settings: Array<[string, string]> = [
    ['outDir', config.outDir],
    [
      'probe.maxRps',
      String(config.probe.maxRps),
    ],
    [
      'probe.timeoutMs',
      String(config.probe.timeoutMs),
    ],
  ]
  return settings.flatMap(([key, current]) => {
    const written = literal(text, key)
    return written.found && written.value !== current
      ? [key]
      : []
  })
}
