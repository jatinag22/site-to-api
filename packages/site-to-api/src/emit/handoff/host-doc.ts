/**
 * `hosts/<host>.md`: everything the folder knows about one host, linked from `AGENT.md`
 * (decision 0041). Session needs with the full bot-protection evidence, cookies, operations,
 * flows, GraphQL and dispatcher endpoints, WebSocket channels, computed values and every gap, one
 * per line. Host names, paths and labels come from the captured site and are escaped.
 */
import type { Analysis, Operation } from '../../model'
import type { StepResolver } from '../steps'
import type { AgentGuideContext } from './context'
import type { GapGroup } from './gaps'
import type { HostRole, RankedHost } from './importance'
import { anchor, code, text } from '../escape'
import { channelsSection } from './channels'
import { computedIntro, computedLine, rankedComputedValues } from './computed'
import { counted, UNTRUSTED_NOTE } from './context'
import { dispatchSection } from './dispatch'
import { graphqlSection } from './graphql'
import { sessionLines } from './session'

const ROLE_TEXT: Record<HostRole, string> = {
  'first-party': 'One of the site\'s own hosts.',
  'pages': 'Serves pages only.',
  'third-party': 'A third-party host the site\'s pages called.',
}

function requestText(operation: Operation): string {
  return operation.sourceOnly && operation.methodUnknown === true
    ? `? ${operation.path}`
    : `${operation.method} ${operation.path}`
}

function kindText(operation: Operation): string {
  const notes = [
    ...(operation.sourceOnly
      ? ['seen in code only']
      : []),
    ...(operation.methodUnknown === true
      ? ['method unknown']
      : []),
  ]
  return notes.length > 0
    ? `${operation.kind}, ${notes.join(', ')}`
    : operation.kind
}

function operationsSection(operations: readonly Operation[]): string[] {
  if (operations.length === 0)
    return []
  return [
    '## Operations',
    '',
    `This host has ${counted(operations.length, 'operation')}; \`API_MAP.md\` has their inputs, origins, needs and client names.`,
    '',
    ...operations.map(operation => `- ${code(operation.operationId)}: ${code(requestText(operation))} (${kindText(operation)})`),
    '',
  ]
}

function flowsSection(host: string, analysis: Analysis, resolver: StepResolver): string[] {
  const flows = analysis.flows.flows.flatMap((flow) => {
    const here = flow.steps.filter(step => resolver.operation(step)?.host === host).length
    return here > 0
      ? [`- [${text(flow.name)}](../flows.md#${anchor(flow.id)}) (${flow.trigger.kind}): ${counted(here, 'step')} on this host of ${flow.steps.length}.`]
      : []
  })
  return flows.length > 0
    ? ['## Flows', '', ...flows, '']
    : []
}

function computedSection(host: string, analysis: Analysis, resolver: StepResolver): string[] {
  const values = rankedComputedValues(analysis.flows.computedValues).filter(value => resolver.computedHost(value) === host)
  if (values.length === 0)
    return []
  return [
    '## Values computed in the browser',
    '',
    computedIntro(analysis.excerpts.size > 0),
    '',
    ...values.map(value => computedLine(value, analysis, resolver)),
    '',
  ]
}

function gapsSection(groups: readonly GapGroup[]): string[] {
  // Nested lists repeat their item lines under different flows, so only plain sentences are deduplicated.
  const lines = groups.flatMap(group => group.markdown ?? [
    ...new Set(group.lines),
  ].map(line => `- ${line}`))
  return [
    '## Gaps',
    '',
    ...(lines.length > 0
      ? lines
      : ['None found for this host.']),
    '',
  ]
}

/** Renders `hosts/<host>.md`. `groups` are this host's gaps. Deterministic. */
export function renderHostDoc(ranked: RankedHost, analysis: Analysis, context: AgentGuideContext, resolver: StepResolver, groups: readonly GapGroup[]): string {
  const { host, session, role } = ranked
  const needs = session === null
    ? ['- No session requirements were recorded for this host: it has no captured API call.']
    : sessionLines(session, analysis, context, role === 'pages')
  const lines = [
    `# ${text(host)}`,
    '',
    `${ROLE_TEXT[role]} Start at [\`AGENT.md\`](../AGENT.md); paths in code spans are relative to the handoff folder. ${UNTRUSTED_NOTE}`,
    '',
    '## Session',
    '',
    ...needs,
    '',
    ...operationsSection(analysis.operations.filter(operation => operation.host === host)),
    ...flowsSection(host, analysis, resolver),
    ...graphqlSection(analysis, host),
    ...dispatchSection(analysis, host),
    ...channelsSection((analysis.channels ?? []).filter(channel => channel.host === host)),
    ...computedSection(host, analysis, resolver),
    ...gapsSection(groups),
  ]
  return `${lines.join('\n').trimEnd()}\n`
}
