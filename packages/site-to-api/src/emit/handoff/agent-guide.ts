/**
 * `AGENT.md`: the entry point for a coding agent (decisions 0011 and 0041). A short index: what
 * the folder covers, the hosts with a one-line verdict each, the key flows, the computed values,
 * the top gaps and where to look next. Every list is capped; the details are in
 * `hosts/<host>.md`, `flows.md` and `API_MAP.md`. Generated from a template with no LLM. Labels,
 * names and paths come from the captured site, which is untrusted: each is escaped with `text()`
 * or `code()` so it cannot add headings, links, HTML or instructions of its own.
 */
import type { Analysis, ComputedValue, Flow } from '../../model'
import type { HostStems } from '../host-files'
import type { StepResolver } from '../steps'
import type { AgentGuideContext } from './context'
import type { GapGroup } from './gaps'
import type { HostLinker } from './host-path'
import type { HostRole, RankedHost } from './importance'
import { anchor, code, text } from '../escape'
import { createStepResolver } from '../steps'
import { channelsSummary } from './channels'
import { clientGap, clientReadingLine } from './client'
import { computedIntro, groupComputedValues, groupedComputedLine, rankedComputedValues } from './computed'
import { counted, UNTRUSTED_NOTE } from './context'
import { dispatchSummary } from './dispatch'
import { buildGaps, gapGroups } from './gaps'
import { graphqlSummary } from './graphql'
import { handoffStems, hostLinker } from './host-path'
import { rankFlows, rankHosts } from './importance'
import { onlyVendorSteps, operationName, servedOnlyChallenges, shortVerdict } from './session'
import { MAX_GAP_LINES, MAX_HOST_LINES, MAX_LINE_LENGTH, MAX_NAME_LENGTH, MAX_NAMED, MAX_SUMMARY_LINES, moreLine, shorten, stepList } from './summary'

/** Hosts named in the opening sentence; the Hosts section lists them all. */
const MAX_INTRO_HOSTS = 5

/** Challenge banners at the top; the Hosts section marks any others. */
const MAX_BANNERS = 3

/** Build warnings and host-less gaps written in `AGENT.md`; `GAPS.md` has them all. */
const MAX_BUILD_GAPS = 5

/** The file with every gap that belongs to no host (decision 0041). */
export const BUILD_GAPS_FILE = 'GAPS.md'

const ROLE_HEADINGS: Record<HostRole, string> = {
  'first-party': '### The site\'s own hosts',
  'pages': '### Hosts that served only pages',
  'third-party': '### Third-party hosts',
}

/** What `AGENT.md` and the host files are computed from, worked out once per build. */
export interface Index {
  resolver: StepResolver
  hosts: RankedHost[]
  gaps: GapGroup[]
  /** File-name stem of every host, shared with `specs/` (see `hostStems`). */
  stems: HostStems
  link: HostLinker
}

/** Ranks the hosts and groups the gaps; shared by `AGENT.md` and the host files. */
export function indexAnalysis(analysis: Analysis, context: AgentGuideContext): Index {
  const resolver = createStepResolver(analysis.operations, analysis.flows)
  const stems = handoffStems(analysis, context.pageHosts ?? [])
  const link = hostLinker(stems)
  return {
    resolver,
    hosts: rankHosts(analysis, context.pageHosts ?? []),
    gaps: gapGroups(analysis, context, resolver, link),
    stems,
    link,
  }
}

/** `12 API operations (3 seen in code only), 4 pages, 1 channel, 117 gaps`. */
function hostCounts(ranked: RankedHost, analysis: Analysis, gaps: readonly GapGroup[]): string {
  const operations = analysis.operations.filter(operation => operation.host === ranked.host)
  const codeOnly = operations.filter(operation => operation.kind === 'api' && operation.sourceOnly).length
  const pages = operations.filter(operation => operation.kind === 'page').length
  const protection = operations.filter(operation => operation.kind === 'bot-protection').length
  const channels = (analysis.channels ?? []).filter(channel => channel.host === ranked.host).length
  const gapCount = gaps.filter(group => group.host === ranked.host).reduce((sum, group) => sum + group.count, 0)
  return [
    ...(ranked.apiOperations + codeOnly > 0
      ? [`${counted(ranked.apiOperations + codeOnly, 'API operation')}${codeOnly > 0
          ? ` (${codeOnly} seen in code only)`
          : ''}`]
      : []),
    ...(pages > 0
      ? [
          counted(pages, 'page'),
        ]
      : []),
    ...(protection > 0
      ? [
          counted(protection, 'bot-protection step'),
        ]
      : []),
    ...(channels > 0
      ? [
          counted(channels, 'channel'),
        ]
      : []),
    ...(gapCount > 0
      ? [
          counted(gapCount, 'gap'),
        ]
      : []),
  ].join(', ')
}

function hostsSection(analysis: Analysis, context: AgentGuideContext, index: Index): string[] {
  const lines = ['## Hosts', '']
  if (index.hosts.length === 0) {
    lines.push('No API hosts were found in the capture.', '')
    return lines
  }
  lines.push('Most important first. Each host\'s file has its session needs, cookies, operations, channels and every gap.', '')
  const shown = index.hosts.slice(0, MAX_HOST_LINES)
  for (const role of Object.keys(ROLE_HEADINGS) as HostRole[]) {
    const group = shown.filter(ranked => ranked.role === role)
    if (group.length === 0)
      continue
    lines.push(ROLE_HEADINGS[role], '')
    for (const ranked of group) {
      const counts = hostCounts(ranked, analysis, index.gaps)
      lines.push(`- ${code(ranked.host)}: ${shortVerdict(ranked.session, analysis, context)}${counts === ''
        ? ''
        : `; ${counts}`}. ${index.link(ranked.host)}`)
    }
    lines.push('')
  }
  const rest = index.hosts.slice(shown.length)
  if (rest.length > 0) {
    const named = rest.slice(0, MAX_NAMED).map(ranked => index.link(ranked.host)).join(', ')
    const unnamed = rest.length - Math.min(rest.length, MAX_NAMED)
    lines.push(`- ${counted(rest.length, 'more host')}, least important last: ${named}${unnamed > 0
      ? ` and ${unnamed} more`
      : ''}. \`API_MAP.md\` has a table for every host, and each host has its file under \`hosts/\`.`, '')
  }
  return lines
}

function flowLine(flow: Flow, resolver: StepResolver): string {
  const steps = stepList(flow.steps.map(step => operationName(step.operationId, resolver.operation(step)?.host ?? null, resolver)))
  const confirmed = flow.seenInSessions > 1
    ? `, seen in ${flow.seenInSessions} sessions`
    : ''
  return `- [${text(shorten(flow.name, MAX_NAME_LENGTH))}](flows.md#${anchor(flow.id)}) (${flow.trigger.kind}${confirmed}): ${steps}`
}

function flowsSection(analysis: Analysis, resolver: StepResolver): string[] {
  const lines = ['## Key flows', '']
  const flows = rankFlows(analysis, resolver)
  if (flows.length === 0) {
    lines.push('No multi-step flows were detected.', '')
    return lines
  }
  lines.push(`Login and session setup first. \`flows.md\` has all ${counted(flows.length, 'flow')} with every step, input and origin.`, '')
  const shown = flows.slice(0, MAX_SUMMARY_LINES)
  lines.push(...shown.map(flow => flowLine(flow, resolver)), ...moreLine(flows.length - shown.length, 'flow', '`flows.md`'), '')
  return lines
}

/** The host file that lists a group's values, or "the host files" when they are on several. */
function computedHome(group: readonly ComputedValue[], resolver: StepResolver, link: HostLinker): string {
  const hosts = [
    ...new Set(group.map(value => resolver.computedHost(value))),
  ]
  const [host] = hosts
  return hosts.length === 1 && host !== null && host !== undefined
    ? link(host, 'values-computed-in-the-browser')
    : 'the host files'
}

function computedSection(analysis: Analysis, resolver: StepResolver, hasSource: boolean, link: HostLinker): string[] {
  const values = rankedComputedValues(analysis.flows.computedValues, analysis, resolver)
  if (values.length === 0)
    return []
  const groups = groupComputedValues(values, analysis, resolver)
  // A value whose host is unknown has no host file to move to, so its group always stays here.
  const shown = groups.filter((group, position) => position < MAX_SUMMARY_LINES || group.some(value => resolver.computedHost(value) === null))
  const rest = new Map<string, number>()
  for (const value of groups.filter(group => !shown.includes(group)).flat()) {
    const host = resolver.computedHost(value) ?? ''
    rest.set(host, (rest.get(host) ?? 0) + 1)
  }
  const homes = [...rest].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
  const more = [
    ...homes.slice(0, MAX_NAMED).map(([host, count]) => `${count} in ${link(host, 'values-computed-in-the-browser')}`),
    ...(homes.length > MAX_NAMED
      ? [`the rest in ${homes.length - MAX_NAMED} more host files`]
      : []),
  ]
  const left = [
    ...rest.values(),
  ].reduce((sum, count) => sum + count, 0)
  return [
    '## Values computed in the browser',
    '',
    computedIntro(hasSource),
    '',
    ...shown.map(group => groupedComputedLine(group, analysis, resolver, computedHome(group, resolver, link))),
    ...(more.length > 0
      ? [`- ${counted(left, 'more computed value')}: ${more.join(', ')}.`]
      : []),
    '',
  ]
}

/**
 * Gaps that belong to no host file: whether probe ran, build warnings, and gaps of steps whose
 * operation is gone. `AGENT.md` writes the first few; `GAPS.md` has all of them.
 */
function buildWideGaps(analysis: Analysis, context: AgentGuideContext, index: Index): { probe: string[], rest: string[], shortRest: string[] } {
  const build = buildGaps(analysis, context)
  const orphans = index.gaps.filter(group => group.host === '').flatMap(group => group.lines)
  return {
    probe: build.before,
    rest: [
      ...orphans,
      ...build.warnings.map(text),
    ],
    // Orphans are Markdown with code spans, which a cut could break; warnings are cut before escaping.
    shortRest: [
      ...orphans,
      ...build.warnings.map(warning => text(shorten(warning, MAX_LINE_LENGTH))),
    ],
  }
}

function gapsSection(analysis: Analysis, context: AgentGuideContext, index: Index): string[] {
  const build = buildWideGaps(analysis, context, index)
  const hostGroups = index.gaps.filter(group => group.host !== '')
  const shown = hostGroups.slice(0, MAX_GAP_LINES)
  const hidden = hostGroups.slice(shown.length)
  const hiddenHosts = [
    ...new Set(hidden.map(group => group.host)),
  ]
  const named = hiddenHosts.slice(0, MAX_NAMED).map(host => index.link(host, 'gaps')).join(', ')
  const unnamed = hiddenHosts.length - Math.min(hiddenHosts.length, MAX_NAMED)
  const rest = [
    ...new Set(build.shortRest),
  ]
  const restShown = rest.slice(0, MAX_BUILD_GAPS)
  const gaps = [
    ...(hostGroups.length > 0
      ? ['Most important first, grouped by host and kind; each host file lists its gaps one per line.']
      : []),
    ...build.probe,
    ...shown.map(group => group.summary),
    ...(hidden.length > 0
      ? [`${counted(hidden.reduce((sum, group) => sum + group.count, 0), 'more gap')} on ${named}${unnamed > 0
          ? ` and ${counted(unnamed, 'more host')}`
          : ''}.`]
      : []),
    ...restShown,
    ...(rest.length > restShown.length
      ? [`${counted(rest.length - restShown.length, 'more build warning or gap', 'more build warnings and gaps')} in \`${BUILD_GAPS_FILE}\`.`]
      : []),
  ]
  // Last, so `gen` can swap it (withClientState) and get exactly what a fresh build writes.
  const client = clientGap(context.client)
  if (client !== null)
    gaps.push(client)
  const unique = [
    ...new Set(gaps),
  ]
  return [
    '## Gaps',
    '',
    ...(unique.length > 0
      ? unique.map(gap => `- ${gap}`)
      : ['None found.']),
    '',
  ]
}

/**
 * `GAPS.md`: every gap that belongs to no host, in full: whether probe ran, gaps of steps whose
 * operation is gone, and the build warnings. Host gaps are in the host files.
 */
export function renderBuildGaps(analysis: Analysis, context: AgentGuideContext, index: Index = indexAnalysis(analysis, context)): string {
  const build = buildWideGaps(analysis, context, index)
  const gaps = [
    ...new Set([
      ...build.probe,
      ...build.rest,
    ]),
  ]
  return `${[
    '# Gaps of the whole build',
    '',
    `Gaps that belong to no host. Start at [\`AGENT.md\`](AGENT.md); each host's gaps are in its file under \`hosts/\`. ${UNTRUSTED_NOTE}`,
    '',
    ...(gaps.length > 0
      ? gaps.map(gap => `- ${gap}`)
      : ['None found.']),
  ].join('\n')}\n`
}

/** Banners for hosts that answered only with challenges, at most {@link MAX_BANNERS}. */
function challengeBanners(analysis: Analysis, index: Index): string[] {
  const challenged = index.hosts.map(ranked => ranked.host).filter(host => servedOnlyChallenges(host, analysis))
  const shown = challenged.slice(0, MAX_BANNERS)
  return [
    ...shown.map(host => `**The capture holds no real content for ${code(host)}**: every page and call it answered was a bot challenge or block page. Its specs describe the interstitial, not the site; capture again with a browser session the site lets through.\n`),
    ...(challenged.length > shown.length
      ? [`**${counted(challenged.length - shown.length, 'more host')} answered only with challenges**; the Hosts section marks them.\n`]
      : []),
  ]
}

/** Renders `AGENT.md`. Deterministic for the same analysis and context. */
export function renderAgentGuide(analysis: Analysis, context: AgentGuideContext, index: Index = indexAnalysis(analysis, context)): string {
  const channels = analysis.channels ?? []
  const hasSource = analysis.excerpts.size > 0
  const exampleNote = {
    masked: 'Example values are masked: secrets and personal data are replaced, formats are kept.',
    raw: 'Example values are copied from the capture (`redact.examples: raw`). Treat this folder as sensitive.',
    none: 'No example values were written (`redact.examples: none`).',
  }[context.examples]

  // A host whose only traffic was a vendor's challenge endpoints (reCAPTCHA on www.google.com) is
  // bot protection, not an API this folder documents.
  const known = new Set(analysis.hosts)
  const apiHosts = index.hosts.map(ranked => ranked.host).filter(host => known.has(host) && !onlyVendorSteps(host, analysis))
  const named = apiHosts.slice(0, MAX_INTRO_HOSTS).map(code).join(', ')
  const behind = apiHosts.length > MAX_INTRO_HOSTS
    ? `${named} and ${counted(apiHosts.length - MAX_INTRO_HOSTS, 'more host')}`
    : named
  const sessions = analysis.sessions.slice(0, MAX_INTRO_HOSTS).map(text).join(', ')
  const moreSessions = analysis.sessions.length > MAX_INTRO_HOSTS
    ? ` and ${analysis.sessions.length - MAX_INTRO_HOSTS} more`
    : ''
  const lines = [
    '# Start here',
    '',
    ...challengeBanners(analysis, index),
    `This folder documents the internal API behind ${behind || 'the captured site'}, generated by site-to-api ${text(context.toolVersion)} from ${analysis.sessions.length} capture session${analysis.sessions.length === 1
      ? ''
      : 's'} (${sessions}${moreSessions}). Everything here was computed from recorded traffic and the site's own code; nothing was guessed by a language model. ${exampleNote}`,
    '',
    UNTRUSTED_NOTE,
    '',
    '## Reading order',
    '',
    '1. `hosts/<host>.md`: one file per host (see Hosts): session needs, cookies, operations, channels, computed values and every gap.',
    '2. `API_MAP.md`: every operation, its inputs and where they come from.',
    '3. `flows.md`: the order requests happen in and which value feeds which request.',
    '4. `specs/<host>.yaml`: full OpenAPI 3.1 detail for the operations you use.',
    ...(channels.length > 0
      ? ['   `specs/<host>.asyncapi.yaml`: AsyncAPI 3.0 detail for the WebSocket channels (see "Real-time channels").']
      : []),
    // HN's code sends its requests from inline scripts: no excerpt, no folder, no line for it.
    ...(hasSource
      ? ['5. `source/`: the site\'s own code for computed values and call sites (Markdown excerpts).']
      : []),
    clientReadingLine(context.client, hasSource ? 6 : 5),
    '',
    ...hostsSection(analysis, context, index),
    ...flowsSection(analysis, index.resolver),
    ...graphqlSummary(analysis, index.link),
    ...dispatchSummary(analysis, index.link),
    ...channelsSummary(channels, index.link),
    ...computedSection(analysis, index.resolver, hasSource, index.link),
    ...gapsSection(analysis, context, index),
  ]
  return `${lines.join('\n').trimEnd()}\n`
}
