/**
 * How `AGENT.md` and `API_MAP.md` describe `client/`. `build --no-client` and `gen` change the
 * client without re-running the analysis (gen has no raw captures in a fresh clone), so the
 * client-dependent sentences are fixed strings here: `build` renders them, and `gen` swaps them
 * in place with {@link updateClientState}, leaving the rest of both files untouched.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'pathe'

/**
 * `current`: generated from these specs. `stale`: left from an earlier build that `--no-client`
 * did not regenerate. `none`: no client in the folder. `empty`: no client because the capture
 * has no API operations to call (only pages or bot-protection steps).
 */
export type ClientState = 'current' | 'stale' | 'none' | 'empty'

const STATES: ClientState[] = ['current', 'stale', 'none', 'empty']

/** The last item of the reading order, without its number (4 or 5, depending on `source/`). */
const READING_LINE: Record<ClientState, string> = {
  current: '`client/`: typed client with Zod validation; see `client/README.md`.',
  stale: '`client/`: from an earlier build and not regenerated (`--no-client`), so it may not match these specs; run `site-to-api gen`.',
  none: '`client/`: not generated; run `site-to-api gen`. `API_MAP.md` names the functions it will have.',
  empty: '`client/`: none, because the capture has no API operations to call (only pages or bot-protection steps).',
}

const GAP: Record<ClientState, string | null> = {
  current: null,
  stale: '`client/` is from an earlier build and was not regenerated (`--no-client`); run `site-to-api gen` to bring it up to date.',
  none: 'No client generated: run `site-to-api gen`.',
  empty: 'No client: the capture has no API operations (only pages or bot-protection steps). Capture the site\'s data requests, or use a browser for this site.',
}

const MAP_LINE: Record<ClientState, string> = {
  current: 'The Client column names the functions and Zod schemas exported by the generated `client/`.',
  stale: 'The Client column names what `site-to-api gen` generates; `client/` is from an earlier build and may not match it until you run gen.',
  none: 'The Client column names what `site-to-api gen` will generate into `client/`; no client has been generated yet.',
  empty: 'There is no client: the capture has no API operations to call.',
}

/** The client item of the reading order in `AGENT.md`, numbered `position`. */
export function clientReadingLine(state: ClientState, position: number): string {
  return `${position}. ${READING_LINE[state]}`
}

/** `[index, number]` of the reading-order line that describes the client, or null. */
function findReadingLine(lines: readonly string[]): [number, number] | null {
  for (const [index, line] of lines.entries()) {
    const match = /^(\d+)\. (.*)$/.exec(line)
    if (match && STATES.some(candidate => READING_LINE[candidate] === match[2])) {
      return [
        index,
        Number(match[1]),
      ]
    }
  }
  return null
}

/** The `AGENT.md` gap for this client state (also printed by `build` as a warning), or `null`. */
export function clientGap(state: ClientState): string | null {
  return GAP[state]
}

/** The sentence in the `API_MAP.md` introduction that says whether the Client column exists yet. */
export function apiMapClientLine(state: ClientState): string {
  return MAP_LINE[state]
}

/** `AGENT.md` with the client line and gap for `state`, or `null` when the file has neither marker. */
export function withClientState(guide: string, state: ClientState): string | null {
  const lines = guide.split('\n')
  const reading = findReadingLine(lines)
  const gaps = lines.indexOf('## Gaps')
  if (reading === null || gaps === -1)
    return null
  lines[reading[0]] = clientReadingLine(state, reading[1])
  const next = lines.findIndex((line, index) => index > gaps && line.startsWith('## '))
  const end = next === -1
    ? lines.length
    : next
  const clientGaps = new Set(STATES.flatMap(candidate => GAP[candidate] ?? []).map(gap => `- ${gap}`))
  const items = lines.slice(gaps + 1, end).filter(line => line.startsWith('- ') && !clientGaps.has(line))
  const gap = GAP[state]
  if (gap !== null)
    items.push(`- ${gap}`)
  const section = [
    '## Gaps',
    '',
    ...(items.length > 0
      ? items
      : ['None found.']),
    '',
  ]
  return [
    ...lines.slice(0, gaps),
    ...section,
    ...lines.slice(end),
  ].join('\n')
}

/** `API_MAP.md` with the client sentence for `state`, or `null` when the file has none. */
export function withApiMapClientState(map: string, state: ClientState): string | null {
  const lines = map.split('\n')
  const index = lines.findIndex(line => STATES.some(candidate => MAP_LINE[candidate] === line))
  if (index === -1)
    return null
  lines[index] = MAP_LINE[state]
  return lines.join('\n')
}

/**
 * Rewrites the client sentences of `AGENT.md` and `API_MAP.md` after `gen`, so both agree with
 * the folder. Returns warnings for files that are missing or were written by another version.
 */
export async function updateClientState(outDir: string, state: ClientState): Promise<string[]> {
  const warnings: string[] = []
  for (const [name, update] of [
    ['AGENT.md', withClientState],
    ['API_MAP.md', withApiMapClientState],
  ] as const) {
    const path = join(outDir, name)
    if (!existsSync(path)) {
      warnings.push(`${name} not found, so it does not mention the new client; run \`site-to-api build\` to write it.`)
      continue
    }
    const updated = update(await readFile(path, 'utf8'), state)
    if (updated === null)
      warnings.push(`${name} does not have the client sentence this version writes, so it was left as it is; run \`site-to-api build\` to rewrite it.`)
    else
      await writeFile(path, updated)
  }
  return warnings
}
