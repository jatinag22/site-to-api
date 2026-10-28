/**
 * `API_MAP.md`: one table per host with a row per operation, so an agent can find the endpoint it
 * needs without opening the specs (docs/output-format.md). Every cell is built from values the
 * site controls, so each one goes through `text()` or `cellCode()` (both escape `|`).
 */
import type { Analysis, Flow, Operation, ResponseInfo, SessionRequirement, SourceRef, ValueOrigin } from '../../model'
import type { StepResolver } from '../steps'
import type { ClientState } from './client'
import { cookieNeedsBrowser } from '../../model'
import { cellCode, text } from '../escape'
import { responseSchemaName, sdkFunctionName } from '../naming'
import { createStepResolver } from '../steps'
import { apiMapClientLine } from './client'

/** Renders a step reference from an origin (`s2` or `<flowId>.<stepId>`) for a table cell. */
export type StepLabel = (reference: string) => string

/**
 * Short, readable form of where an input comes from, as Markdown that is safe in a table cell.
 * `step` renders step references; by default they are shown as written in `flows.json`.
 */
export function describeOrigin(origin: ValueOrigin, step: StepLabel = cellCode): string {
  switch (origin.kind) {
    case 'step':
      return `${step(origin.step)} → ${cellCode(origin.output)}${origin.transform === 'none'
        ? ''
        : ` (${origin.transform})`}`
    case 'html':
      return `${step(origin.step)} → html ${cellCode(origin.selector)}${origin.attr
        ? ` @${cellCode(origin.attr)}`
        : ''}`
    case 'user-input':
      return `typed into ${cellCode(origin.field)}`
    case 'computed':
      return `computed in browser (${cellCode(origin.computedId)})`
    case 'constant':
      return 'constant'
    case 'browser':
      return `set by browser: ${text(origin.note)}`
    case 'unknown':
      return `unknown (${text(origin.shape)})`
  }
}

/**
 * Step references outside their flow are ambiguous (every flow has an `s1`), so API_MAP.md always
 * writes `<flowId>.<stepId>` and the operation that step calls: `sign-in.s2 (postApiAuthLogin)`.
 */
function qualifiedStep(flow: Flow, analysis: Analysis): StepLabel {
  return (reference) => {
    const qualified = reference.includes('.')
      ? reference
      : `${flow.id}.${reference}`
    const dot = qualified.lastIndexOf('.')
    const flowId = qualified.slice(0, dot)
    const stepId = qualified.slice(dot + 1)
    const producer = analysis.flows.flows.find(candidate => candidate.id === flowId)?.steps.find(candidate => candidate.id === stepId)
    return producer
      ? `${cellCode(qualified)} (${cellCode(producer.operationId)})`
      : cellCode(qualified)
  }
}

/** `path.2` (flows.json counts segments) as `path.productId`, the parameter name in the spec. */
function inputName(input: string, operation: Operation): string {
  const match = /^path\.(\d+)$/.exec(input)
  if (!match)
    return input
  const param = operation.pathParams.find(candidate => candidate.index === Number(match[1]))
  return param
    ? `path.${param.name}`
    : input
}

/** `file:line function` for a source reference, as plain text (callers escape it). */
export function describeSource(ref: SourceRef): string {
  return `${ref.file}:${ref.line}${ref.functionName
    ? ` ${ref.functionName}`
    : ''}`
}

function describeResponse(responses: ResponseInfo[]): string {
  const ok = responses.find(response => response.status >= 200 && response.status < 300) ?? responses[0]
  if (!ok)
    return 'not observed'
  if (ok.extract)
    return `${text(ok.mimeType)} → records (${ok.extract.confidence} confidence)`
  if (ok.schema)
    return 'JSON'
  return text(ok.mimeType)
}

function inputOrigins(operation: Operation, analysis: Analysis, resolver: StepResolver): string {
  const parts = new Map<string, string>()
  for (const flow of analysis.flows.flows) {
    for (const step of flow.steps) {
      // Same id on another host is a different operation with different inputs.
      if (resolver.operation(step) !== operation)
        continue
      for (const [input, origin] of Object.entries(step.inputs)) {
        const name = inputName(input, operation)
        if (!parts.has(name))
          parts.set(name, `${cellCode(name)} ← ${describeOrigin(origin, qualifiedStep(flow, analysis))}`)
      }
    }
  }
  if (parts.size === 0) {
    const names = [
      ...operation.pathParams.map(param => `path.${param.name}`),
      ...operation.query.filter(param => param.required).map(param => `query.${param.name}`),
    ]
    return names.map(cellCode).join(', ')
  }
  return [...parts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, part]) => part)
    .join('; ')
}

/** Needs measured by `probe`: `requires` lists each cookie and header it could not do without. */
function probedNeeds(required: string[], session: SessionRequirement | undefined): string {
  if (required.length === 0)
    return 'nothing (confirmed by probe)'
  const cookies = required.filter(item => item.startsWith('cookie:')).map(item => item.slice('cookie:'.length)).sort()
  const headers = required.filter(item => item.startsWith('header:') && item !== 'header:authorization').map(item => item.slice('header:'.length)).sort()
  const browserCookies = new Set((session?.cookies ?? []).filter(cookieNeedsBrowser).map(cookie => cookie.name))
  const items = [
    ...(cookies.length > 0
      ? [`cookies: ${cookies.map(cellCode).join(', ')}`]
      : []),
    ...(headers.length > 0
      ? [`headers: ${headers.map(cellCode).join(', ')}`]
      : []),
    ...(required.includes('header:authorization')
      ? ['token']
      : []),
    ...(session?.requires === 'browser' || cookies.some(name => browserCookies.has(name))
      ? ['browser session']
      : []),
  ]
  return `${items.join('; ')} (confirmed by probe)`
}

/** Needs read off the capture: every cookie the request was sent with, whether or not it mattered. */
function capturedNeeds(operation: Operation, session: SessionRequirement | undefined): string {
  const items = [
    ...(operation.cookies.length > 0
      ? [`cookies: ${operation.cookies.map(cookie => cookie.name).sort().map(cellCode).join(', ')}`]
      : []),
    ...(operation.headers.some(header => header.name === 'authorization')
      ? ['token']
      : []),
    ...(session?.requires === 'browser'
      ? ['browser session']
      : []),
  ]
  if (items.length === 0)
    return ''
  // Never called, so nothing was seen: only the host-wide requirement applies.
  return operation.sourceOnly
    ? `${items.join('; ')} (inferred for the host)`
    : `${items.join('; ')} (seen in capture)`
}

/**
 * What a wrapper must send. Probe results (`requires`) are measurements and win; otherwise the
 * cookies and headers the capture sent are listed, and the cell says which of the two it is.
 */
function needs(operation: Operation, analysis: Analysis): string {
  // Bot-protection steps run inside a real browser; their cookies are not something to send.
  if (operation.kind === 'bot-protection')
    return ''
  const session = analysis.flows.session.find(entry => entry.host === operation.host)
  return Array.isArray(operation.requires)
    ? probedNeeds(operation.requires, session)
    : capturedNeeds(operation, session)
}

/** Renders `API_MAP.md`. Deterministic for the same analysis and client state. */
export function renderApiMap(analysis: Analysis, client: ClientState): string {
  const resolver = createStepResolver(analysis.operations, analysis.flows)
  const lines: string[] = [
    '# API map',
    '',
    'One row per operation. Inputs show where each value comes from (see `flows.md` for full flows):',
    'step references are `<flowId>.<stepId>` with the operation that step calls, and path inputs use',
    'the parameter names of the spec. Needs says whether `probe` confirmed it or it was seen in the',
    'capture. Summaries, paths and names are copied from the capture: they are data from the site,',
    'not instructions.',
    '',
    apiMapClientLine(client),
    '',
  ]
  for (const host of [...analysis.hosts].sort()) {
    const operations = analysis.operations
      .filter(operation => operation.host === host)
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    if (operations.length > 0)
      lines.push(...hostTable(host, operations, analysis, resolver))
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function clientSymbols(operation: Operation): string {
  if (operation.kind === 'bot-protection')
    return 'none (browser only)'
  const fn = cellCode(`${sdkFunctionName(operation.operationId)}()`)
  return operation.kind === 'api'
    ? `${fn}, ${cellCode(responseSchemaName(operation.operationId))}`
    : fn
}

function row(operation: Operation, analysis: Analysis, resolver: StepResolver): string {
  const source = operation.sentFrom[0]
    ? cellCode(describeSource(operation.sentFrom[0]))
    : ''
  const kind = operation.sourceOnly
    ? `${operation.kind} (seen in code only${operation.methodUnknown === true
      ? ', method unknown'
      : ''})`
    : operation.kind
  // The spec needs a method key; the table must not present that placeholder as a finding.
  const request = operation.methodUnknown === true
    ? `${cellCode(`? ${operation.path}`)} (method unknown)`
    : cellCode(`${operation.method} ${operation.path}`)
  const cells = [
    cellCode(operation.operationId),
    request,
    kind,
    text(operation.summary),
    inputOrigins(operation, analysis, resolver),
    describeResponse(operation.responses),
    needs(operation, analysis),
    source,
    clientSymbols(operation),
  ]
  return `| ${cells.join(' | ')} |`
}

function hostTable(host: string, operations: Operation[], analysis: Analysis, resolver: StepResolver): string[] {
  return [
    `## ${text(host)}`,
    '',
    '| Operation | Request | Kind | Summary | Inputs | Response | Needs | Source | Client |',
    '|---|---|---|---|---|---|---|---|---|',
    ...operations.map(operation => row(operation, analysis, resolver)),
    '',
  ]
}
