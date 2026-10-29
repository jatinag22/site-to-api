/**
 * The dispatcher parts of `AGENT.md` ("Dispatcher endpoints") and `API_MAP.md` (a table per
 * endpoint), decision 0039. Values and parameter names come from the captured site, so each goes
 * through `text()`, `code()` or `cellCode()` (decision 0019).
 */
import type { Analysis, DispatchOperation, Operation } from '../../model'
import { cellCode, code, text } from '../escape'
import { sdkFunctionName } from '../naming'

type DispatchEntry = Operation & { dispatch: DispatchOperation }

/** Parameters shown per function; the spec has the rest. */
const MAX_PARAMETERS = 8

function isDispatch(operation: Operation): operation is DispatchEntry {
  return operation.dispatch !== undefined
}

/** Endpoints (`GET host/path` plus the parameter) with their functions, sorted by endpoint then value. */
function byEndpoint(analysis: Analysis): Array<[string, DispatchEntry[]]> {
  const groups = new Map<string, DispatchEntry[]>()
  for (const operation of analysis.operations.filter(isDispatch)) {
    const key = `${operation.method} ${operation.host}${operation.dispatch.endpoint}`
    groups.set(key, [
      ...(groups.get(key) ?? []),
      operation,
    ])
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, operations]) => [
      key,
      operations.sort((a, b) => a.dispatch.value.localeCompare(b.dispatch.value)),
    ])
}

/** Where the caller's own parameters go: the query string, or the body next to the dispatcher. */
function argumentName(dispatch: DispatchOperation): 'query' | 'body' {
  return dispatch.in === 'query'
    ? 'query'
    : 'body'
}

/** The caller's parameters (`symbol`, `days?`), without the dispatcher, which the client sends. */
function parameterNames(operation: DispatchEntry): string[] {
  const { dispatch } = operation
  if (dispatch.in === 'query') {
    return operation.query
      .filter(param => param.name !== dispatch.parameter)
      .map(param => `${param.name}${param.required ? '' : '?'}`)
  }
  const schema = operation.requestBody?.schema
  const required = new Set(schema?.required ?? [])
  return Object.keys(schema?.properties ?? {})
    .filter(name => name !== dispatch.parameter)
    .map(name => `${name}${required.has(name)
      ? ''
      : '?'}`)
}

function shown(names: string[]): string[] {
  const list = names.slice(0, MAX_PARAMETERS)
  return names.length > list.length
    ? [...list, `+${names.length - list.length} more`]
    : list
}

function clientCall(operation: DispatchEntry): string {
  const names = parameterNames(operation).map(name => name.replace(/\?$/, ''))
  const fn = `sdk.${sdkFunctionName(operation.operationId)}`
  if (names.length === 0)
    return `${fn}()`
  const listed = names.length > 3
    ? `${names.slice(0, 3).join(', ')}, ...`
    : names.join(', ')
  return `${fn}({ ${argumentName(operation.dispatch)}: { ${listed} } })`
}

function where(dispatch: DispatchOperation): string {
  switch (dispatch.in) {
    case 'query':
      return 'query parameter'
    case 'form':
      return 'form field'
    case 'json':
      return 'JSON body field'
  }
}

function agentLine(operation: DispatchEntry): string {
  const names = shown(parameterNames(operation))
  const parameters = names.length > 0
    ? `parameters ${names.map(code).join(', ')}`
    : 'no other parameters'
  return `- ${code(operation.dispatch.value)}: ${parameters}. Client: ${code(clientCall(operation))}; spec path ${code(operation.path)}.`
}

/** The "Dispatcher endpoints" section of `AGENT.md`; empty when the capture has none. */
export function dispatchSection(analysis: Analysis): string[] {
  const groups = byEndpoint(analysis)
  if (groups.length === 0)
    return []
  const lines = [
    '## Dispatcher endpoints',
    '',
    'On these endpoints one parameter picks the function (`functionName`, `action`, JSON-RPC',
    '`method`...): each value sent different parameters or got a differently shaped response. Each',
    'function is its own operation in the spec (marked `x-site-to-api-dispatch`, path',
    '`<endpoint>#<value>`; the fragment is never sent) and its own client function, which sends the',
    'dispatcher parameter itself. Values the capture never showed are not listed.',
    '',
  ]
  for (const [endpoint, operations] of groups) {
    const first = operations[0]!.dispatch
    lines.push(
      `### ${code(endpoint)}`,
      '',
      `Dispatcher: ${where(first)} ${code(first.parameter)}, ${operations.length} function${operations.length === 1
        ? ''
        : 's'}.`,
      '',
      ...operations.map(agentLine),
      '',
    )
  }
  return lines
}

/** The dispatcher tables of `API_MAP.md`, one per endpoint; empty when the capture has none. */
export function dispatchTables(analysis: Analysis): string[] {
  const groups = byEndpoint(analysis)
  if (groups.length === 0)
    return []
  const lines = [
    '## Dispatcher endpoints',
    '',
    'One table per endpoint where a parameter picks the function; each row is also a row of its host table above.',
    '',
  ]
  for (const [endpoint, operations] of groups) {
    const first = operations[0]!.dispatch
    lines.push(
      `### ${text(endpoint)} (${text(where(first))} ${cellCode(first.parameter)})`,
      '',
      '| Function | Operation | Parameters | Client |',
      '|---|---|---|---|',
      ...operations.map(operation => `| ${[
        cellCode(operation.dispatch.value),
        cellCode(operation.operationId),
        shown(parameterNames(operation)).map(cellCode).join(', '),
        cellCode(clientCall(operation)),
      ].join(' | ')} |`),
      '',
    )
  }
  return lines
}

/** The Client cell of a dispatcher function's row: the call that sends the dispatcher itself. */
export function dispatchClientCall(operation: Operation): string | null {
  return isDispatch(operation)
    ? clientCall(operation)
    : null
}

/** `api (function getSymbolData)` for the Kind column of a host table. */
export function dispatchKind(operation: Operation): string | null {
  return operation.dispatch
    ? `${operation.kind} (function ${text(operation.dispatch.value)})`
    : null
}
