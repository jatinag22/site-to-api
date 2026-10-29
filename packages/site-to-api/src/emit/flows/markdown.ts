/** Renders `flows.json` as `flows.md` for coding agents and people. */
import type { ComputedValue, Flow, FlowsDocument, FlowStep, Operation, SourceRef, ValueOrigin } from '../../model'
import type { StepResolver } from '../steps'
import { anchor, cellCode, code, text } from '../escape'
import { NO_SOURCE } from '../handoff/source-ref'
import { responseSchemaName, sdkFunctionName } from '../naming'
import { createStepResolver } from '../steps'

function sourceRef(ref: SourceRef): string {
  const location = `${ref.file}:${ref.line}${ref.functionName
    ? ` ${ref.functionName}`
    : ''}`
  const excerpt = ref.excerpt
    ? ` (excerpt: ${code(ref.excerpt)})`
    : ''
  const bundle = ref.original ? '' : ' (bundle)'
  return `${code(location)}${bundle}${excerpt}`
}

function stepLink(step: string, flowId: string): string {
  const dot = step.indexOf('.')
  if (dot === -1)
    return `step ${code(step)}`
  const flow = step.slice(0, dot)
  return `step ${code(step.slice(dot + 1))} of [${code(flow)}](#${anchor(flow === flowId
    ? flowId
    : flow)})`
}

function describeOrigin(origin: ValueOrigin, flowId: string): string {
  switch (origin.kind) {
    case 'step': {
      const transform = origin.transform === 'none'
        ? ''
        : ` (${origin.transform})`
      return `from ${stepLink(origin.step, flowId)} response ${code(origin.output)}${transform}`
    }
    case 'html': {
      if (origin.selector === '')
        return `from the HTML of ${stepLink(origin.step, flowId)} (no selector inferred, confidence ${origin.confidence})`
      const attr = origin.attr
        ? ` attribute ${code(origin.attr)}`
        : ' text'
      const pattern = origin.pattern
        ? `, pattern ${code(origin.pattern)}`
        : ''
      return `from the HTML of ${stepLink(origin.step, flowId)}: ${code(origin.selector)}${attr}${pattern} (confidence ${origin.confidence})`
    }
    case 'user-input':
      return `typed by the person into field ${code(origin.field)}`
    case 'computed':
      return `computed by the page, see [${code(origin.computedId)}](#${computedAnchor(origin.computedId)})`
    case 'constant':
      return `constant ${code(origin.value)}`
    case 'browser':
      return `set in the browser: ${text(origin.note)}`
    case 'unknown':
      return `unknown origin (${text(origin.shape)})`
  }
}

function computedAnchor(id: string): string {
  return anchor(`computed-${id}`)
}

function operationLine(step: FlowStep, operation: Operation | undefined): string {
  const endpoint = operation
    ? ` ${code(`${operation.method} ${operation.path}`)}`
    : ''
  const host = operation
    ? ` on ${code(operation.host)}`
    : ''
  return `**${code(step.operationId)}**${endpoint}${host}`
}

function sentFromText(step: FlowStep, operation: Operation | undefined): string {
  if (step.sentFrom)
    return sourceRef(step.sentFrom)
  return operation?.sourceUnavailable === true
    ? NO_SOURCE
    : 'unknown (no initiator stack)'
}

function renderStep(step: FlowStep, index: number, flow: Flow, resolver: StepResolver): string[] {
  const operation = resolver.operation(step) ?? undefined
  const lines = [`${index + 1}. ${operationLine(step, operation)} (step ${code(step.id)}, ${step.kind})`]
  const item = (line: string): void => {
    lines.push(`   - ${line}`)
  }
  item(text(step.summary))
  if (step.browserOnly)
    item('Browser only: a real browser must run this step; it is not a client function.')
  else
    item(`SDK function ${code(`${sdkFunctionName(step.operationId)}()`)}, response schema ${code(responseSchemaName(step.operationId))}`)
  item(`Sent from: ${sentFromText(step, operation)}`)
  const inputs = Object.entries(step.inputs)
  if (inputs.length === 0) {
    item('Inputs: none traced')
  }
  else {
    item('Inputs:')
    for (const [key, origin] of inputs)
      lines.push(`     - ${code(key)}: ${describeOrigin(origin, flow.id)}`)
  }
  const outputs = Object.entries(step.outputs)
  if (outputs.length > 0)
    item(`Outputs used later: ${outputs.map(([name, location]) => `${code(name)} = ${code(location)}`).join(', ')}`)
  return lines
}

function renderFlow(flow: Flow, resolver: StepResolver): string[] {
  const where = flow.trigger.pageUrl
    ? ` on ${code(flow.trigger.pageUrl)}`
    : ''
  const sessions = flow.seenInSessions === 1
    ? '1 session'
    : `${flow.seenInSessions} sessions`
  return [
    `<a id="${anchor(flow.id)}"></a>`,
    '',
    `### ${text(flow.name)}`,
    '',
    `Trigger: ${flow.trigger.kind} ${code(flow.trigger.label)}${where}. Seen in ${sessions}.`,
    '',
    ...flow.steps.flatMap((step, index) => renderStep(step, index, flow, resolver)),
    '',
  ]
}

function renderComputed(value: ComputedValue, resolver: StepResolver): string[] {
  const host = resolver.ambiguous(value.operationId)
    ? resolver.computedHost(value)
    : null
  const lines = [
    `<a id="${computedAnchor(value.id)}"></a>`,
    '',
    `### ${code(value.id)}`,
    '',
    `- Request value: ${code(value.input)} of ${code(value.operationId)}${host === null
      ? ''
      : ` on ${code(host)}`}`,
    `- Port: ${value.producedBy
      ? `${code(value.producedBy.file)}, function ${code(value.producedBy.functionName ?? '(anonymous)')} at line ${value.producedBy.line}`
      : 'source location unknown'}${value.producedBy?.excerpt
      ? ` (excerpt: ${code(value.producedBy.excerpt)})`
      : ''}`,
    `- Called from: ${value.calledFrom
      ? sourceRef(value.calledFrom)
      : 'unknown'}`,
  ]
  if (value.api) {
    const details = value.details
      ? ` (${text(Object.entries(value.details).sort(([a], [b]) => a.localeCompare(b)).map(([key, detail]) => `${key}=${detail}`).join(', '))})`
      : ''
    lines.push(`- Browser API: ${code(value.api)}${details}`)
  }
  if (value.uses.length > 0) {
    lines.push('- Uses:')
    for (const use of value.uses)
      lines.push(`  - ${describeOrigin(use, '')}`)
  }
  lines.push(`- Evidence: ${value.evidence}`, '')
  return lines
}

function renderSessionTable(session: FlowsDocument['session']): string[] {
  if (session.length === 0)
    return ['No API hosts found.', '']
  const rows = session.map((host) => {
    // Table cells: cellCode escapes the pipes a cookie name could use to add columns.
    const cookies = host.cookies
      .map(cookie => `${cellCode(cookie.name)} (${cookie.setBy
        ? cellCode(cookie.setBy)
        : cookie.source})`)
      .join(', ') || 'none'
    const bots = host.botProtection.map(bot => text(bot.vendor)).join(', ') || 'none'
    return `| ${cellCode(host.host)} | ${host.requires} | ${cookies} | ${bots} | ${host.probed ? 'yes' : 'no'} |`
  })
  return [
    '| Host | Requires | Cookies (set by) | Bot protection | Probed |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ]
}

function renderContents(flows: readonly Flow[]): string[] {
  if (flows.length === 0)
    return ['No flows found.', '']
  return [
    ...flows.map(flow => `- [${text(flow.name)}](#${anchor(flow.id)}): ${flow.steps.map(step => code(step.operationId)).join(' → ')}`),
    '',
  ]
}

/** `flows.md`: session needs, a table of contents, one section per flow and the computed values. */
export function renderFlowsMarkdown(doc: FlowsDocument, operations: readonly Operation[]): string {
  // Operation ids are unique per host only; the resolver finds a step's host from its exchanges.
  const resolver = createStepResolver(operations, doc)
  const sessions = `${doc.sessions.length === 1
    ? 'session'
    : 'sessions'} ${doc.sessions.map(code).join(', ')}`
  const computedIntro = doc.computedValues.length === 0
    ? 'None: every traced value came from a response, the person, a constant or the browser.'
    : 'Values the page computes before sending them. Port the named function to send them without a browser.'
  const lines = [
    '# Flows',
    '',
    `Generated by ${text(doc.generatedBy)} from ${sessions}. Source of truth: \`flows.json\`.`,
    '',
    '## Session requirements',
    '',
    ...renderSessionTable(doc.session),
    '## Flows',
    '',
    ...renderContents(doc.flows),
    ...doc.flows.flatMap(flow => renderFlow(flow, resolver)),
    '## Computed values',
    '',
    computedIntro,
    '',
    ...doc.computedValues.flatMap(value => renderComputed(value, resolver)),
  ]
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
