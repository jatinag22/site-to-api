/**
 * Finds endpoint strings in the site's code: arguments of `fetch`, axios, jQuery and
 * `XMLHttpRequest.open` calls, `new URL(...)`, and other literals that look like API paths. These
 * give path templates with real parameter names, and endpoints the capture never called.
 */
import type { Argument, BinaryExpression, CallExpression, Expression, NewExpression, ObjectExpression, Program, TemplateLiteral } from 'oxc-parser'
import type { LoadedSession, SourceRef, SourceRoute } from '../../model'
import type { LiteralNode } from './ast'
import type { CodeFile } from './files'
import { expressionName, keyName, LineIndex, memberPropertyName, parseCode, walkWithFunctions } from './ast'
import { compare, readSessionFile, siteCodeFiles } from './files'

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
])

/** Method names on HTTP client objects that send a request with that verb. */
const VERB_METHODS: Record<string, string> = {
  get: 'GET',
  getJSON: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  del: 'DELETE',
  patch: 'PATCH',
  head: 'HEAD',
  options: 'OPTIONS',
}

/** Objects whose `.get(...)` / `.post(...)` send HTTP requests, so any `/path` argument counts. */
const CLIENT_OBJECT = /axios|https?|api|client|request|ajax|^\$$|jquery|instance|service|fetcher|^ky$|superagent|rest/i

/** Callee names that suggest the function sends requests (the brief's `get|post|...|api` rule). */
const REQUEST_FUNCTION = /get|post|put|delete|request|fetch|api/i

const FETCH_CALLEES = new Set([
  'fetch',
  'window.fetch',
  'globalThis.fetch',
  'self.fetch',
])
const CONFIG_CALLEES = new Set([
  'axios',
  'axios.request',
  '$.ajax',
  'jQuery.ajax',
])

/** Placeholder names that stand for a base URL rather than a path parameter. */
const BASE_NAME = /url|base|host|origin|api|endpoint|domain|server|root|prefix/i

/** Paths that only name an API root (`/api`, `/api/v2`), i.e. a base URL constant, not an endpoint. */
const BASE_ONLY = /^(?:\/(?:apis?|rest|v\d+))+\/?$/i

const ASSET_EXTENSION = /\.(?:m?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp[34]|webm|wasm)$/i

/** Which call shape found the route; decides how strict the path check is. */
type Context = 'request' | 'url' | 'standalone'

type Part = { kind: 'text', value: string } | { kind: 'param', name: string | null }

interface Found {
  method: string | null
  host: string | null
  pathTemplate: string
  params: string[]
  ref: SourceRef
}

function hasApiSegment(path: string): boolean {
  for (const segment of path.split('/')) {
    const lower = segment.toLowerCase()
    // `api` must start or end a segment (`/api2`, `/myapi`) so words like `rapid` do not count.
    if (/^apis?(?:$|[^a-z])/.test(lower) || /(?:^|[^a-z])apis?$/.test(lower) || /[^a-z]apis?[^a-z]/.test(lower))
      return true
    if (/^(?:rest|graphql|gql)(?:$|[^a-z])/.test(lower) || /^v\d+$/.test(lower))
      return true
  }
  return /\.(?:json|aspx|ashx|asmx|php|do|action|jsp|cgi)(?:$|\/)/i.test(path)
}

const PASS_THROUGH_CALLS = /^(?:encodeURI(?:Component)?|escape|String|Number)$/

/** Name for a placeholder, from the interpolated expression (`product.id` → `id`). */
function paramName(node: Expression): string | null {
  switch (node.type) {
    case 'Identifier':
      return node.name
    case 'MemberExpression':
      return memberPropertyName(node)?.replace(/^#/, '') ?? null
    case 'CallExpression':
      return callParamName(node)
    case 'ChainExpression':
      return node.expression.type === 'MemberExpression'
        ? paramName(node.expression)
        : null
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
      return paramName(node.expression)
    default:
      return null
  }
}

function callParamName(node: CallExpression): string | null {
  const callee = expressionName(node.callee)
  const first = expressionArg(node.arguments[0])
  // `encodeURIComponent(id)` and `String(id)` carry the argument's meaning, not their own.
  if (callee !== null && PASS_THROUGH_CALLS.test(callee) && first)
    return paramName(first)
  const name = callee?.split('.').pop()
  return name === undefined
    ? null
    : name.replace(/^get(?=[A-Z])/, '')
}

/** Identifies a node so the standalone pass does not report a literal a call already used. */
function nodeKey(node: { type: string, start: number, end: number }): string {
  return `${node.type}:${node.start}:${node.end}`
}

/** String constants declared in a file (`const API_BASE = 'https://…'`), by name. */
type Constants = Map<string, string>

/** Shared state while turning URL expressions of one file into templates. */
interface TemplateScope {
  consumed: Set<string>
  constants: Constants
}

function valuePart(node: Expression, scope: TemplateScope): Part {
  const constant = node.type === 'Identifier'
    ? scope.constants.get(node.name)
    : undefined
  return constant === undefined
    ? {
        kind: 'param',
        name: paramName(node),
      }
    : { kind: 'text', value: constant }
}

function isConcatenation(node: Expression): boolean {
  return node.type === 'Literal' || node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+')
}

function templateParts(node: TemplateLiteral, scope: TemplateScope, out: Part[]): void {
  node.quasis.forEach((quasi, index) => {
    out.push({ kind: 'text', value: quasi.value.cooked ?? quasi.value.raw })
    const expression = node.expressions[index]
    if (expression)
      out.push(valuePart(expression, scope))
  })
}

/** Flattens a literal, template literal or `+` concatenation into text and placeholders. */
function collectParts(node: Expression, scope: TemplateScope, out: Part[]): boolean {
  if (node.type === 'Literal') {
    scope.consumed.add(nodeKey(node))
    if (typeof node.value !== 'string')
      return false
    out.push({ kind: 'text', value: node.value })
    return true
  }
  if (node.type === 'TemplateLiteral') {
    scope.consumed.add(nodeKey(node))
    templateParts(node, scope, out)
    return true
  }
  if (node.type !== 'BinaryExpression' || node.operator !== '+')
    return false
  scope.consumed.add(nodeKey(node))
  for (const side of [node.left, node.right]) {
    if (!isConcatenation(side))
      out.push(valuePart(side, scope))
    else if (!collectParts(side, scope, out))
      return false
  }
  return true
}

function mergeText(parts: Part[]): Part[] {
  const merged: Part[] = []
  for (const part of parts) {
    const last = merged.at(-1)
    if (part.kind === 'text' && last?.kind === 'text')
      last.value += part.value
    else if (part.kind === 'param' || part.value !== '')
      merged.push({ ...part })
  }
  return merged
}

/**
 * Drops leading placeholders that stand for the API base: followed by `/`, or named like a base
 * URL (`${API}users`). Returns `null` when a leading placeholder looks like part of the path.
 */
function stripBase(parts: Part[]): Part[] | null {
  const rest = [...parts]
  while (rest[0]?.kind === 'param') {
    const base = rest[0]
    const next = rest[1]
    if (next?.kind !== 'text')
      return null
    const namedBase = base.name !== null && BASE_NAME.test(base.name) && /^[\w-]/.test(next.value)
    if (!namedBase && !next.value.startsWith('/') && !next.value.startsWith('?'))
      return null
    rest.shift()
    if (namedBase && !next.value.startsWith('/'))
      next.value = `/${next.value}`
  }
  return rest
}

/** Renders parts as `{name}` text; repeated names get a number (`id`, `id2`), unnamed ones `paramN`. */
function render(parts: Part[]): { text: string, params: string[] } {
  const used = new Map<string, number>()
  const params: string[] = []
  let text = ''
  let unnamed = 0
  for (const part of parts) {
    if (part.kind === 'text') {
      text += part.value
      continue
    }
    const raw = (part.name ?? '').replace(/\W/g, '')
    const base = raw === ''
      ? `param${++unnamed}`
      : raw
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    const name = count === 1
      ? base
      : `${base}${count}`
    params.push(name)
    text += `{${name}}`
  }
  return { text, params }
}

/** Splits `https://host/path` and `//host/path` into host and path; relative text has no host. */
function splitHost(text: string): { host: string | null, rest: string } | null {
  const scheme = /^(?:https?:)?\/\//i.exec(text)
  if (!scheme)
    return { host: null, rest: text }
  const afterScheme = text.slice(scheme[0].length)
  const end = afterScheme.search(/[/?#]/)
  const host = end === -1
    ? afterScheme
    : afterScheme.slice(0, end)
  if (host === '' || host.includes('{'))
    return null
  return {
    host: host.toLowerCase(),
    rest: end === -1
      ? '/'
      : afterScheme.slice(end),
  }
}

/** Turns a URL expression into a host and a `{name}` path template without query or fragment. */
function toTemplate(node: Expression, scope: TemplateScope): { host: string | null, pathTemplate: string, params: string[] } | null {
  const parts: Part[] = []
  const whole = valuePart(node, scope)
  if (whole.kind === 'text')
    parts.push(whole)
  else if (!collectParts(node, scope, parts))
    return null
  const stripped = stripBase(mergeText(parts))
  if (!stripped)
    return null
  const { text, params } = render(stripped)
  const split = splitHost(text)
  if (!split)
    return null
  const path = split.rest.replace(/[?#].*$/, '')
  return {
    host: split.host,
    pathTemplate: path,
    params: params.filter(name => path.includes(`{${name}}`)),
  }
}

function isPlausiblePath(path: string): boolean {
  return path.startsWith('/')
    && !path.startsWith('//')
    && path.length <= 300
    && !/[\s"'<>`\\]/.test(path)
    && !ASSET_EXTENSION.test(path)
}

function upperMethod(node: Expression | undefined): string | null {
  if (node?.type !== 'Literal' || typeof node.value !== 'string')
    return null
  const method = node.value.toUpperCase()
  return HTTP_METHODS.has(method)
    ? method
    : null
}

function property(object: ObjectExpression, ...names: string[]): Expression | undefined | 'spread' {
  let found: Expression | undefined
  for (const prop of object.properties) {
    if (prop.type === 'SpreadElement')
      return 'spread'
    const key = prop.computed
      ? null
      : keyName(prop.key)
    if (key !== null && names.includes(key))
      found = prop.value
  }
  return found
}

/** Method from a fetch-style options argument: absent options mean GET. */
function optionsMethod(options: Argument | undefined, defaultMethod: string): string | null {
  if (options === undefined)
    return defaultMethod
  if (options.type !== 'ObjectExpression')
    return null
  const method = property(options, 'method', 'type')
  if (method === 'spread')
    return null
  return method === undefined
    ? defaultMethod
    : upperMethod(method)
}

function expressionArg(node: Argument | undefined): Expression | null {
  return node === undefined || node.type === 'SpreadElement'
    ? null
    : node
}

/** The value of a string literal or a template literal without interpolation. */
function staticString(node: Expression): string | null {
  if (node.type === 'Literal') {
    return typeof node.value === 'string'
      ? node.value
      : null
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null
  return null
}

/**
 * String constants of a file, so `${API_BASE}/x` resolves to the real base URL. Names assigned two
 * different strings are left out because the value at the call site is then unknown.
 */
function fileConstants(program: Program): Constants {
  const constants: Constants = new Map()
  const conflicting = new Set<string>()
  walkWithFunctions(program, () => ({
    VariableDeclarator: (node) => {
      if (node.id.type !== 'Identifier' || !node.init)
        return
      const value = staticString(node.init)
      const name = node.id.name
      if (value === null || conflicting.has(name))
        return
      if (constants.has(name) && constants.get(name) !== value) {
        constants.delete(name)
        conflicting.add(name)
        return
      }
      constants.set(name, value)
    },
  }))
  return constants
}

/** Collects the routes of one file; the call handlers below feed it. */
class FileRoutes {
  readonly found: Found[] = []
  readonly scope: TemplateScope
  private readonly lines: LineIndex
  currentFunction: () => string | null = () => null

  constructor(program: Program, text: string, private readonly file: CodeFile) {
    this.lines = new LineIndex(text)
    this.scope = {
      consumed: new Set(),
      constants: fileConstants(program),
    }
  }

  add(urlNode: Expression | null, at: number, method: string | null, context: Context, base: Expression | null = null): void {
    if (urlNode === null)
      return
    const template = toTemplate(urlNode, this.scope)
    if (!template || !isPlausiblePath(template.pathTemplate))
      return
    // `new URL('/path', 'https://host')`: the host comes from the base argument.
    const host = template.host ?? (base
      ? toTemplate(base, this.scope)?.host ?? null
      : null)
    const apiLike = hasApiSegment(template.pathTemplate)
    if (context === 'standalone' && (!apiLike || BASE_ONLY.test(template.pathTemplate)))
      return
    if (context === 'url' && host === null && !apiLike)
      return
    const { line, column } = this.lines.position(at)
    const ref: SourceRef = {
      file: this.file.path,
      line,
      column,
      functionName: this.currentFunction(),
      original: this.file.kind === 'original',
      excerpt: null,
    }
    this.found.push({
      method,
      host,
      pathTemplate: template.pathTemplate,
      params: template.params,
      ref,
    })
  }
}

function onNew(routes: FileRoutes, node: NewExpression, callee: string): void {
  const first = expressionArg(node.arguments[0])
  if (callee === 'URL')
    routes.add(first, node.start, null, 'url', expressionArg(node.arguments[1]))
  else if (callee === 'Request')
    routes.add(first, node.start, optionsMethod(node.arguments[1], 'GET'), 'request')
}

/** `axios({ url, method })`, `$.ajax({ url, type })`, and their `(url, options)` forms. */
function onConfigCall(routes: FileRoutes, node: CallExpression): void {
  const first = expressionArg(node.arguments[0])
  if (first?.type !== 'ObjectExpression') {
    routes.add(first, node.start, optionsMethod(node.arguments[1], 'GET'), 'request')
    return
  }
  const url = property(first, 'url')
  if (url !== 'spread' && url !== undefined)
    routes.add(url, node.start, optionsMethod(first, 'GET'), 'request')
}

/** `xhr.open(method, url)`, `client.get(url)`, and calls to functions named like requests. */
function onMethodCall(routes: FileRoutes, node: CallExpression, callee: string): void {
  const args = node.arguments
  const first = expressionArg(args[0])
  const segments = callee.split('.')
  const last = segments.at(-1) ?? ''
  const object = segments.slice(0, -1).join('.')
  const openMethod = last === 'open' && args.length >= 2
    ? upperMethod(first ?? undefined)
    : null
  if (openMethod !== null) {
    routes.add(expressionArg(args[1]), node.start, openMethod, 'request')
    return
  }
  const verb = VERB_METHODS[last]
  if (verb !== undefined && object !== '') {
    routes.add(first, node.start, verb, CLIENT_OBJECT.test(object)
      ? 'request'
      : 'standalone')
    return
  }
  if (REQUEST_FUNCTION.test(last)) {
    for (const arg of args)
      routes.add(expressionArg(arg), node.start, null, 'request')
  }
}

function onCall(routes: FileRoutes, node: CallExpression): void {
  const callee = expressionName(node.callee)
  if (callee === null)
    return
  if (FETCH_CALLEES.has(callee))
    routes.add(expressionArg(node.arguments[0]), node.start, optionsMethod(node.arguments[1], 'GET'), 'request')
  else if (CONFIG_CALLEES.has(callee))
    onConfigCall(routes, node)
  else
    onMethodCall(routes, node, callee)
}

function onStandalone(routes: FileRoutes, node: LiteralNode | TemplateLiteral | BinaryExpression): void {
  if (routes.scope.consumed.has(nodeKey(node)))
    return
  if ((node.type === 'BinaryExpression' && node.operator !== '+') || (node.type === 'Literal' && typeof node.value !== 'string'))
    return
  routes.add(node, node.start, null, 'standalone')
}

/** Parses one file and returns the routes it mentions, in source order. */
function routesInFile(program: Program, text: string, file: CodeFile): Found[] {
  const routes = new FileRoutes(program, text, file)
  walkWithFunctions(program, (current) => {
    routes.currentFunction = current
    return {
      CallExpression: node => onCall(routes, node),
      NewExpression: (node) => {
        const callee = expressionName(node.callee)
        if (callee !== null)
          onNew(routes, node, callee)
      },
      Literal: node => onStandalone(routes, node),
      TemplateLiteral: node => onStandalone(routes, node),
      BinaryExpression: node => onStandalone(routes, node),
    }
  })
  return routes.found
}

function compareRefs(a: SourceRef, b: SourceRef): number {
  return compare(a.file, b.file) || a.line - b.line || a.column - b.column
}

/**
 * Endpoints mentioned in the site's code across all sessions: original sources when sourcemaps
 * were unpacked, otherwise the saved bundles. Routes are deduplicated by method, host and path
 * template (a route without a method is dropped when the same path was found with one), keep the
 * earliest source location, and are sorted by host, path and method.
 */
export async function findSourceEndpoints(sessions: LoadedSession[]): Promise<SourceRoute[]> {
  const parsed = new Map<string, string>()
  const all: Found[] = []
  for (const session of sessions) {
    for (const file of siteCodeFiles(session)) {
      const text = await readSessionFile(session, file.file)
      const key = `${file.kind}:${file.host}:${file.path}`
      // The same file is usually captured in every session; parse each distinct version once.
      if (text === null || parsed.get(key) === text)
        continue
      parsed.set(key, text)
      const program = parseCode(file.path, text, file.kind === 'bundle')
      if (program)
        all.push(...routesInFile(program, text, file))
    }
  }
  return deduplicate(all)
}

function deduplicate(all: Found[]): SourceRoute[] {
  all.sort((a, b) => compareRefs(a.ref, b.ref))
  const pathKey = (route: Found): string => `${route.host ?? ''} ${route.pathTemplate}`
  const byKey = new Map<string, Found>()
  const withMethod = new Set<string>()
  for (const route of all) {
    if (route.method !== null)
      withMethod.add(pathKey(route))
    const key = `${route.method ?? ''} ${pathKey(route)}`
    if (!byKey.has(key))
      byKey.set(key, route)
  }
  return [
    ...byKey.values(),
  ]
    .filter(route => route.method !== null || !withMethod.has(pathKey(route)))
    .sort((a, b) => compare(a.host ?? '', b.host ?? '') || compare(a.pathTemplate, b.pathTemplate) || compare(a.method ?? '', b.method ?? ''))
    .map(({ method, host, pathTemplate, params, ref }) => ({
      method,
      host,
      pathTemplate,
      params,
      ref,
    }))
}
