/**
 * The gaps of a build: what the analysis could not work out, each with what would resolve it.
 * Every gap belongs to a host and is written in full, one per line, in `hosts/<host>.md`.
 * `AGENT.md` shows them grouped (one line per host and kind, most important first) so a site with
 * hundreds of untraced inputs still has a short entry point (decision 0041).
 */
import type { Analysis, Operation } from '../../model'
import type { StepResolver } from '../steps'
import type { AgentGuideContext, ProbeGaps } from './context'
import type { HostLinker } from './host-path'
import { code, text } from '../escape'
import { channelGaps } from './channels'
import { counted } from './context'
import { operationName } from './session'

/**
 * Kinds of host gap, most important first: a probe that failed says the verdict may be wrong,
 * untraced inputs block a wrapper, code-only endpoints and one-sample layouts only limit it.
 */
type GapKind = 'probe-failure' | 'unknown-origin' | 'low-confidence' | 'source-only' | 'not-minimized' | 'channel'

const PRIORITY: Record<GapKind, number> = {
  'probe-failure': 0,
  'unknown-origin': 1,
  'low-confidence': 2,
  'source-only': 3,
  'not-minimized': 4,
  'channel': 5,
}

/** The gaps of one kind on one host. */
export interface GapGroup {
  host: string
  kind: GapKind
  /** How many things are missing (operations, inputs, messages). */
  count: number
  /** One sentence per gap, without the list marker; what `AGENT.md` writes for a gap of no host. */
  lines: string[]
  /**
   * The list lines of the host file when they are not one item per sentence (untraced inputs are
   * nested under their flow); `null` writes {@link lines} as they are.
   */
  markdown: string[] | null
  /** The grouped line for `AGENT.md`, without the list marker. */
  summary: string
}

/** Names shown in a grouped line before "and N more". */
const MAX_NAMES = 3

/** `` `a`, `b`, `c` and 4 more in `hosts/x.md` `` */
function names(items: readonly string[], host: string, link: HostLinker): string {
  const shown = items.slice(0, MAX_NAMES).join(', ')
  return items.length > MAX_NAMES
    ? `${shown} and ${items.length - MAX_NAMES} more in ${link(host, 'gaps')}`
    : shown
}

/** The grouped line of a group with one gap: its sentence, saying which host it is on. */
function single(group: GapGroup): string {
  return `On ${code(group.host)}: ${group.lines[0] ?? ''}`
}

function push(groups: Map<string, GapGroup>, host: string, kind: GapKind, line: string, build: (group: GapGroup) => string): void {
  const key = `${kind}\u0000${host}`
  const group = groups.get(key) ?? {
    host,
    kind,
    count: 0,
    lines: [],
    markdown: null,
    summary: '',
  }
  group.lines.push(line)
  group.count += 1
  group.summary = build(group)
  groups.set(key, group)
}

/** Most common first, then by name: `UUID ×172, 32 hex chars ×60`. */
function topShapes(shapes: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const shape of shapes)
    counts.set(shape, (counts.get(shape) ?? 0) + 1)
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, MAX_NAMES)
    .map(([shape, count]) => `${text(shape)} ×${count}`)
    .join(', ')
}

function operationGaps(analysis: Analysis, resolver: StepResolver, groups: Map<string, GapGroup>, link: HostLinker): void {
  const name = (operation: Operation): string => operationName(operation.operationId, operation.host, resolver)
  const lowConfidence = new Map<string, string[]>()
  const sourceOnly = new Map<string, { names: string[], unknownMethod: number }>()
  for (const operation of analysis.operations) {
    for (const response of operation.responses.filter(candidate => candidate.extract?.confidence === 'low')) {
      const list = [
        ...(lowConfidence.get(operation.host) ?? []),
        name(operation),
      ]
      lowConfidence.set(operation.host, list)
      push(groups, operation.host, 'low-confidence', `${name(operation)} returns ${text(response.mimeType)} whose record layout was inferred from one sample. Capture again and open a second page of the same kind to confirm it.`, group => group.count === 1
        ? single(group)
        : `${group.count} responses on ${code(group.host)} have a record layout inferred from one sample: ${names(list, group.host, link)}. Capture again and open a second page of each kind to confirm them.`)
    }
    if (!operation.sourceOnly)
      continue
    const entry = sourceOnly.get(operation.host) ?? { names: [], unknownMethod: 0 }
    entry.names.push(name(operation))
    if (operation.methodUnknown === true)
      entry.unknownMethod += 1
    sourceOnly.set(operation.host, entry)
    const line = operation.methodUnknown === true
      ? `${name(operation)} (${code(operation.path)}, method unknown: the spec lists it as ${code(operation.method)} only because OpenAPI needs a method) appears in the site's code but was never called during capture; its method and response shape are unknown. Use the feature that calls it during a capture.`
      : `${name(operation)} (${code(`${operation.method} ${operation.path}`)}) appears in the site's code but was never called during capture; its response shape is unknown. Use the feature that calls it during a capture.`
    push(groups, operation.host, 'source-only', line, group => group.count === 1
      ? single(group)
      : `${group.count} operations on ${code(group.host)} appear only in the site's code and were never called during capture${entry.unknownMethod > 0
        ? ` (${entry.unknownMethod} with method unknown)`
        : ''}: ${names(entry.names, group.host, link)}. Use the features that call them during a capture.`)
  }
}

function unknownOriginGaps(analysis: Analysis, resolver: StepResolver, groups: Map<string, GapGroup>, link: HostLinker): void {
  const shapes = new Map<string, string[]>()
  // Host → flow id → `input of operation (shape)`, for one nested list per flow in the host file.
  const nested = new Map<string, Map<string, string[]>>()
  for (const flow of analysis.flows.flows) {
    for (const step of flow.steps) {
      const host = resolver.operation(step)?.host ?? null
      for (const [input, origin] of Object.entries(step.inputs)) {
        if (origin.kind !== 'unknown')
          continue
        // A step whose operation is gone has no host file: its gap goes under the empty host,
        // which AGENT.md lists in full.
        const owner = host ?? ''
        const list = [
          ...(shapes.get(owner) ?? []),
          origin.shape,
        ]
        shapes.set(owner, list)
        const flows = nested.get(owner) ?? new Map<string, string[]>()
        flows.set(flow.id, [
          ...(flows.get(flow.id) ?? []),
          `${code(input)} of ${operationName(step.operationId, host, resolver)} (${text(origin.shape)})`,
        ])
        nested.set(owner, flows)
        push(groups, owner, 'unknown-origin', `In flow ${code(flow.id)}, ${code(input)} of ${operationName(step.operationId, host, resolver)} has no known origin (${text(origin.shape)}). A second capture often shows whether it is constant.`, group => group.count === 1
          ? single(group)
          : `${group.count} request inputs on ${code(group.host)} have no known origin (most often ${topShapes(list)}); each is listed in ${link(group.host, 'gaps')}. A second capture often shows whether they are constant.`)
      }
    }
  }
  for (const [host, flows] of nested) {
    const group = groups.get(`unknown-origin\u0000${host}`)
    if (group === undefined || group.count === 1)
      continue
    group.markdown = [...flows].map(([flowId, all]): [string, string[]] => [
      flowId,
      [
        ...new Set(all),
      ],
    ]).flatMap(([flowId, items]) => items.length === 1
      ? [`- In flow ${code(flowId)}, ${items[0]} has no known origin. A second capture often shows whether it is constant.`]
      : [
          `- In flow ${code(flowId)}, ${items.length} inputs have no known origin; a second capture often shows whether they are constant:`,
          ...items.map(item => `  - ${item}`),
        ])
  }
}

/** One gap per host where `probe` stopped minimizing at `probe.minimizePerHost`. */
function probeGaps(probe: ProbeGaps, groups: Map<string, GapGroup>, link: HostLinker): void {
  const byHost = new Map<string, string[]>()
  for (const entry of probe.notMinimized) {
    byHost.set(entry.host, [
      ...(byHost.get(entry.host) ?? []),
      entry.operationId,
    ])
  }
  for (const [host, ids] of [...byHost].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = ids.sort().map(code)
    const sentence = (list: string): string => `\`probe\` did not work out which cookies and headers ${counted(ids.length, 'operation')} on ${code(host)} need (${list}): it minimizes at most ${probe.minimizePerHost} operations per host (\`probe.minimizePerHost\`), so their Needs in \`API_MAP.md\` are as seen in the capture. Run \`site-to-api probe --minimize-per-host ${probe.minimizePerHost + ids.length}\` to test them too.`
    groups.set(`not-minimized\u0000${host}`, {
      host,
      kind: 'not-minimized',
      count: ids.length,
      lines: [
        sentence(sorted.join(', ')),
      ],
      markdown: null,
      summary: sentence(names(sorted, host, link)),
    })
  }
}

/** One gap per host with operations probe replayed but could not confirm. */
function probeFailureGaps(probe: ProbeGaps, groups: Map<string, GapGroup>, link: HostLinker): void {
  const byHost = new Map<string, string[]>()
  for (const entry of probe.failures) {
    byHost.set(entry.host, [
      ...(byHost.get(entry.host) ?? []),
      `${code(entry.operationId)} (${text(entry.reason)})`,
    ])
  }
  for (const [host, items] of [...byHost].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = items.sort()
    const sentence = (list: string): string => `\`probe\` could not confirm what ${counted(items.length, 'operation')} on ${code(host)} need: ${list}. Their Needs are as seen in the capture; the notes in \`probe.json\` say what the site answered.`
    groups.set(`probe-failure\u0000${host}`, {
      host,
      kind: 'probe-failure',
      count: items.length,
      lines: [
        sentence(sorted.join(', ')),
      ],
      markdown: null,
      summary: sentence(names(sorted, host, link)),
    })
  }
}

function webSocketGaps(analysis: Analysis, groups: Map<string, GapGroup>, link: HostLinker): void {
  for (const channel of analysis.channels ?? []) {
    for (const line of channelGaps([channel])) {
      push(groups, channel.host, 'channel', line, group => group.count === 1
        ? single(group)
        : `${group.count} WebSocket messages or directions on ${code(group.host)} could not be grouped by type or have a schema from a sample of their frames; each is listed in ${link(group.host, 'gaps')}.`)
    }
  }
}

/** Every host gap, grouped by host and kind, most important first (then most items, then host). */
export function gapGroups(analysis: Analysis, context: AgentGuideContext, resolver: StepResolver, link: HostLinker): GapGroup[] {
  const groups = new Map<string, GapGroup>()
  operationGaps(analysis, resolver, groups, link)
  unknownOriginGaps(analysis, resolver, groups, link)
  webSocketGaps(analysis, groups, link)
  if (context.probe) {
    probeGaps(context.probe, groups, link)
    probeFailureGaps(context.probe, groups, link)
  }
  return [
    ...groups.values(),
  ].sort((a, b) =>
    PRIORITY[a.kind] - PRIORITY[b.kind] || b.count - a.count || a.host.localeCompare(b.host))
}

/**
 * Gaps of the whole build rather than of one host: whether probe ran (Markdown) and the build
 * warnings (raw text, which quotes file names and URLs from the capture, for the caller to escape).
 */
export function buildGaps(analysis: Analysis, context: AgentGuideContext): { before: string[], warnings: string[] } {
  const before: string[] = []
  if (!context.probe)
    before.push('`site-to-api probe` has not been run, so session requirements are inferred, not tested.')
  else if (context.probe.replayed === 0)
    before.push(`\`site-to-api probe\` ran but replayed no operation (${context.probe.skipped} skipped; the reasons are in \`probe.json\`), so session requirements are inferred, not tested.`)
  return {
    before,
    warnings: [...analysis.warnings],
  }
}
