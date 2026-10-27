/**
 * `AGENT.md`: the entry point for a coding agent (decision 0011). Generated from a template with
 * no LLM; every sentence is derived from the analysis.
 */
import type { Analysis, SessionRequirement } from '../../model'
import { hostSlug } from '../naming'
import { describeSource } from './api-map'

export interface AgentGuideContext {
  toolVersion: string
  /** Redaction mode used, so the reader knows whether examples are real. */
  examples: 'masked' | 'raw' | 'none'
  /** Whether `probe` has been run against the live site. */
  probed: boolean
  /** Whether `gen` has produced `client/`. */
  hasClient: boolean
}

const REQUIREMENT_TEXT: Record<SessionRequirement['requires'], string> = {
  none: 'plain HTTP works; no session needed',
  cookies: 'plain HTTP with a cookie jar',
  token: 'plain HTTP with a bearer token (obtained from a login step)',
  browser: 'a real browser is needed to establish the session; reuse its cookies for plain HTTP calls',
  unknown: 'unknown; run `site-to-api probe` to find out',
}

function sessionSection(analysis: Analysis): string[] {
  const lines = ['## Session requirements', '']
  if (analysis.flows.session.length === 0) {
    lines.push('No API hosts were found in the capture.', '')
    return lines
  }
  for (const entry of [...analysis.flows.session].sort((a, b) => a.host.localeCompare(b.host))) {
    lines.push(`### ${entry.host}`, '')
    lines.push(`- Needs: ${REQUIREMENT_TEXT[entry.requires]}${entry.probed ? ' (confirmed by probe)' : ' (inferred from the capture, not yet probed)'}.`)
    for (const finding of entry.botProtection)
      lines.push(`- Bot protection: ${finding.vendor} (${finding.evidence}). Do not try to reproduce it; let a real browser run it (\`browserSession\` in \`@site-to-api/runtime\`).`)
    for (const cookie of [...entry.cookies].sort((a, b) => a.name.localeCompare(b.name))) {
      const origin = cookie.source === 'browser'
        ? 'set by a script in the page'
        : cookie.setBy
          ? `set by \`${cookie.setBy}\``
          : 'origin unknown'
      lines.push(`- Cookie \`${cookie.name}\`: ${origin}.`)
    }
    lines.push(`- Spec: \`specs/${hostSlug(entry.host)}.yaml\`.`, '')
  }
  return lines
}

function flowsSection(analysis: Analysis): string[] {
  const lines = ['## Flows', '']
  if (analysis.flows.flows.length === 0) {
    lines.push('No multi-step flows were detected.', '')
    return lines
  }
  for (const flow of analysis.flows.flows) {
    const steps = flow.steps.map(step => `\`${step.operationId}\``).join(' → ')
    const confirmed = flow.seenInSessions > 1
      ? `, seen in ${flow.seenInSessions} sessions`
      : ''
    lines.push(`- [${flow.name}](flows.md#${flow.id}) (${flow.trigger.kind}${confirmed}): ${steps}`)
  }
  lines.push('')
  return lines
}

function computedSection(analysis: Analysis): string[] {
  if (analysis.flows.computedValues.length === 0)
    return []
  const lines = [
    '## Values computed in the browser',
    '',
    'The wrapper must reproduce these. Port the function named here; the excerpt is in `source/`.',
    '',
  ]
  for (const value of analysis.flows.computedValues) {
    const where = value.producedBy
      ? `\`${describeSource(value.producedBy)}\``
      : 'location not found'
    const how = value.api
      ? ` using \`${value.api}\`${value.details
        ? ` (${Object.entries(value.details).map(([key, detail]) => `${key}=${detail}`).join(', ')})`
        : ''}`
      : ''
    lines.push(`- \`${value.input}\` of \`${value.operationId}\`: ${where}${how}.`)
  }
  lines.push('')
  return lines
}

function operationGaps(analysis: Analysis): string[] {
  return analysis.operations.flatMap((operation) => {
    const gaps = operation.responses
      .filter(response => response.extract?.confidence === 'low')
      .map(response => `\`${operation.operationId}\` returns ${response.mimeType} whose record layout was inferred from one sample. Capture again and open a second page of the same kind to confirm it.`)
    if (operation.sourceOnly)
      gaps.push(`\`${operation.operationId}\` (\`${operation.method} ${operation.path}\`) appears in the site's code but was never called during capture; its response shape is unknown. Use the feature that calls it during a capture.`)
    return gaps
  })
}

function unknownOriginGaps(analysis: Analysis): string[] {
  return analysis.flows.flows.flatMap(flow => flow.steps.flatMap(step =>
    Object.entries(step.inputs)
      .filter(([, origin]) => origin.kind === 'unknown')
      .map(([input, origin]) => `In flow \`${flow.id}\`, \`${input}\` of \`${step.operationId}\` has no known origin (${origin.kind === 'unknown'
        ? origin.shape
        : ''}). A second capture often shows whether it is constant.`),
  ))
}

function gapsSection(analysis: Analysis, context: AgentGuideContext): string[] {
  const gaps = [
    ...operationGaps(analysis),
    ...unknownOriginGaps(analysis),
  ]
  if (!context.probed)
    gaps.push('`site-to-api probe` has not been run, so session requirements are inferred, not tested.')
  if (!context.hasClient)
    gaps.push('No client generated yet: run `site-to-api gen`.')
  gaps.push(...analysis.warnings)
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

/** Renders `AGENT.md`. Deterministic for the same analysis and context. */
export function renderAgentGuide(analysis: Analysis, context: AgentGuideContext): string {
  const exampleNote = {
    masked: 'Example values are masked: secrets and personal data are replaced, formats are kept.',
    raw: 'Example values are copied from the capture (`redact.examples: raw`). Treat this folder as sensitive.',
    none: 'No example values were written (`redact.examples: none`).',
  }[context.examples]

  const lines = [
    '# Start here',
    '',
    `This folder documents the internal API behind ${analysis.hosts.map(host => `\`${host}\``).join(', ') || 'the captured site'}, generated by site-to-api ${context.toolVersion} from ${analysis.sessions.length} capture session${analysis.sessions.length === 1
      ? ''
      : 's'} (${analysis.sessions.join(', ')}). Everything here was computed from recorded traffic and the site's own code; nothing was guessed by a language model. ${exampleNote}`,
    '',
    '## Reading order',
    '',
    '1. `API_MAP.md`: every operation, its inputs and where they come from.',
    '2. `flows.md`: the order requests happen in and which value feeds which request.',
    '3. `specs/<host>.yaml`: full OpenAPI 3.1 detail for the operations you use.',
    '4. `source/`: the site\'s own code for computed values and call sites.',
    context.hasClient
      ? '5. `client/`: typed client with Zod validation; see `client/README.md`.'
      : '5. `client/`: not generated yet (`site-to-api gen`).',
    '',
    ...sessionSection(analysis),
    ...flowsSection(analysis),
    ...computedSection(analysis),
    ...gapsSection(analysis, context),
  ]
  return `${lines.join('\n').trimEnd()}\n`
}
