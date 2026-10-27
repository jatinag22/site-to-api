/** Renders `flows.json` as `flows.md` for coding agents and people. */
import type { ComputedValue, Flow, FlowsDocument, FlowStep, Operation, SourceRef, ValueOrigin } from '../../model'

/** Name of the generated Zod schema for an operation's response, e.g. `zGetApiItemsResponse`. */
export function responseSchemaName(operationId: string): string {
  const pascal = operationId
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join('')
  return `z${pascal}Response`
}

/** Inline text: one line, Markdown punctuation escaped so labels from the site cannot break the page. */
function text(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>|#]/g, match => `\\${match}`)
}

/** Inline code; uses a longer fence when the content itself has backticks. */
function code(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  const fence = flat.includes('`')
    ? '``'
    : '`'
  return `${fence}${flat.includes('`')
    ? ` ${flat} `
    : flat}${fence}`
}

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
  return `step ${code(step.slice(dot + 1))} of [${code(flow)}](#${flow === flowId
    ? flowId
    : flow})`
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
  return `computed-${id}`
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

function renderStep(step: FlowStep, index: number, flow: Flow, operations: ReadonlyMap<string, Operation>): string[] {
  const operation = operations.get(step.operationId)
  const lines = [`${index + 1}. ${operationLine(step, operation)} (step ${code(step.id)}, ${step.kind})`]
  const item = (line: string): void => {
    lines.push(`   - ${line}`)
  }
  item(text(step.summary))
  if (step.browserOnly)
    item('Browser only: a real browser must run this step; it is not a client function.')
  else
    item(`SDK function ${code(`${step.operationId}()`)}, response schema ${code(responseSchemaName(step.operationId))}`)
  item(`Sent from: ${step.sentFrom
    ? sourceRef(step.sentFrom)
    : 'unknown (no initiator stack)'}`)
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

function renderFlow(flow: Flow, operations: ReadonlyMap<string, Operation>): string[] {
  const where = flow.trigger.pageUrl
    ? ` on ${code(flow.trigger.pageUrl)}`
    : ''
  const sessions = flow.seenInSessions === 1
    ? '1 session'
    : `${flow.seenInSessions} sessions`
  return [
    `<a id="${flow.id}"></a>`,
    '',
    `### ${text(flow.name)}`,
    '',
    `Trigger: ${flow.trigger.kind} ${code(flow.trigger.label)}${where}. Seen in ${sessions}.`,
    '',
    ...flow.steps.flatMap((step, index) => renderStep(step, index, flow, operations)),
    '',
  ]
}

function renderComputed(value: ComputedValue): string[] {
  const lines = [
    `<a id="${computedAnchor(value.id)}"></a>`,
    '',
    `### ${code(value.id)}`,
    '',
    `- Request value: ${code(value.input)} of ${code(value.operationId)}`,
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
    const cookies = host.cookies
      .map(cookie => `${code(cookie.name)} (${cookie.setBy
        ? code(cookie.setBy)
        : cookie.source})`)
      .join(', ') || 'none'
    const bots = host.botProtection.map(bot => text(bot.vendor)).join(', ') || 'none'
    return `| ${code(host.host)} | ${host.requires} | ${cookies} | ${bots} | ${host.probed ? 'yes' : 'no'} |`
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
    ...flows.map(flow => `- [${text(flow.name)}](#${flow.id}): ${flow.steps.map(step => code(step.operationId)).join(' → ')}`),
    '',
  ]
}

/** `flows.md`: session needs, a table of contents, one section per flow and the computed values. */
export function renderFlowsMarkdown(doc: FlowsDocument, operations: readonly Operation[]): string {
  const byId = new Map<string, Operation>()
  // Operation ids are unique per host; a step only names the id, so the first host wins.
  for (const operation of [...operations].sort((a, b) => a.host.localeCompare(b.host) || a.operationId.localeCompare(b.operationId))) {
    if (!byId.has(operation.operationId))
      byId.set(operation.operationId, operation)
  }
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
    ...doc.flows.flatMap(flow => renderFlow(flow, byId)),
    '## Computed values',
    '',
    computedIntro,
    '',
    ...doc.computedValues.flatMap(renderComputed),
  ]
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
