/**
 * Drops endpoints found in code that cannot be real calls: URL templates and test fixtures
 * scanned as hosts (`www.%suffixorigin%`, `a@b`, `stub-host`, `localhost:4318`), XML namespaces
 * (`http://www.w3.org/2000/svg`), analytics and telemetry endpoints (dropped from traffic too),
 * file-system paths from bundler output
 * (`/ROOT/node_modules/.pnpm/...`) and paths that still hold a placeholder the scanner could not
 * resolve (`/{str}.php`, `translations{param1}{toString}`, `{API_ENDPOINT}`). A code-only route
 * becomes an operation, a spec and a client method, so a junk one costs every reader.
 *
 * Hosts the captured traffic used are always kept: a site served from `localhost` or an internal
 * name is still that site.
 */
import type { SourceRoute } from '../../model'
import { findNoise } from '../classify'

/** Top-level names that never resolve on the public internet (RFC 2606, 6761, 6762, common LAN). */
const NON_PUBLIC_TLDS: ReadonlySet<string> = new Set([
  'localhost',
  'local',
  'localdomain',
  'test',
  'example',
  'invalid',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
])

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
const PORT = /^\d{1,5}$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Namespace URIs that markup code passes around as strings; they are never fetched. */
const XML_NAMESPACES: ReadonlyArray<{ host: string, path: RegExp }> = [
  { host: 'www.w3.org', path: /^\/(?:2000\/svg|1999\/xhtml|1999\/xlink|2000\/xmlns\/?|XML\/1998\/namespace|1998\/Math\/MathML|1999\/02\/22-rdf-syntax-ns)$/ },
]

/** Path segments that only appear in file-system paths: bundler roots and package folders. */
const FILE_SYSTEM_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  '.pnpm',
  '.yarn',
  '.next',
  'webpack:',
  '__webpack_require__',
])
/** First segments of absolute file-system paths (`/ROOT/...` is how webpack names the project). */
const FILE_SYSTEM_ROOTS: ReadonlySet<string> = new Set([
  'ROOT',
  'Users',
  'home',
  'tmp',
  'private',
  'var',
  'opt',
  'usr',
  'Volumes',
  'mnt',
])
/** Source files, not endpoints. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|scss|less|d\.ts)$/i

/** `{name}` as a whole segment, or followed by a data-format extension (`/items/{id}.json`). */
const PLACEHOLDER_SEGMENT = /^\{[a-z_$][\w$]*\}(?:\.(?:json|xml|csv|txt))?$/i
/** An environment or config constant (`{API_ENDPOINT}`), not a route parameter. */
const CONSTANT_PLACEHOLDER = /\{[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\}/
/** printf, `$1` and moustache placeholders the scanner leaves as text. */
const TEXT_PLACEHOLDER = /%[sdif](?![0-9a-f])|%[a-z]\w*%|\$\d|\{\{|\}\}/

export interface ScreenedRoutes {
  routes: SourceRoute[]
  /** One line for the build warnings, or `null` when nothing was dropped. */
  warning: string | null
}

/** Why a host cannot be a real API host, or `null` when it can. */
function hostProblem(host: string): string | null {
  const [name = '', port, ...rest] = host.split(':')
  if (rest.length > 0 || (port !== undefined && !PORT.test(port)))
    return 'not a hostname'
  if (IPV4.test(name))
    return 'an IP address'
  const labels = name.split('.')
  if (labels.length < 2 || !labels.every(label => LABEL.test(label)))
    return 'not a hostname'
  const tld = labels[labels.length - 1]!
  if (!TLD.test(tld) || NON_PUBLIC_TLDS.has(tld))
    return 'not a public hostname'
  // RFC 2606 documentation domains: placeholders in docs and defaults, never the site's API.
  if (/(?:^|\.)example\.(?:com|net|org)$/.test(name))
    return 'a documentation domain'
  return null
}

/** Why a path cannot be a real endpoint, or `null` when it can. */
function pathProblem(path: string): string | null {
  const segments = path.split('/').slice(1)
  if (segments.some(segment => FILE_SYSTEM_SEGMENTS.has(segment)) || FILE_SYSTEM_ROOTS.has(segments[0] ?? '') || SOURCE_FILE.test(path))
    return 'a file-system path'
  if (TEXT_PLACEHOLDER.test(path) || CONSTANT_PLACEHOLDER.test(path))
    return 'a template placeholder'
  if (segments.some(segment => segment.includes('{') && !PLACEHOLDER_SEGMENT.test(segment)))
    return 'a template placeholder'
  // A path that is nothing but a placeholder is a URL the scanner could not see into.
  if (segments.filter(segment => segment !== '').every(segment => PLACEHOLDER_SEGMENT.test(segment)) && segments.some(segment => segment !== ''))
    return 'a template placeholder'
  return null
}

function quote(text: string): string {
  const short = text.length > 60
    ? `${text.slice(0, 57)}...`
    : text
  return JSON.stringify(short)
}

/** `autocompletes{query}`: a literal name with a query string glued on by the code. */
const GLUED_QUERY = /^([\w.~-]+)\{([a-z_$][\w$]*)\}$/i

/**
 * `/api/v2/autocompletes{e}` is how the scanner sees `'/api/v2/autocompletes' + query`: the
 * endpoint is the literal part, so the trailing placeholder is dropped instead of the route.
 */
function withoutGluedQuery(route: SourceRoute): SourceRoute {
  const slash = route.pathTemplate.lastIndexOf('/')
  const match = GLUED_QUERY.exec(route.pathTemplate.slice(slash + 1))
  if (!match)
    return route
  return {
    ...route,
    pathTemplate: `${route.pathTemplate.slice(0, slash + 1)}${match[1]}`,
    params: route.params.filter(name => name !== match[2]),
  }
}

/** Why a code-only route cannot be a real call, or `null` when it can. */
function routeProblem(route: SourceRoute, observedHosts: ReadonlySet<string>): string | null {
  const { host, pathTemplate } = route
  if (host === null)
    return pathProblem(pathTemplate)
  if (!observedHosts.has(host)) {
    const problem = hostProblem(host)
    if (problem !== null)
      return problem
  }
  if (XML_NAMESPACES.some(namespace => namespace.host === host && namespace.path.test(pathTemplate)))
    return 'an XML namespace'
  if (findNoise(host, pathTemplate) !== null)
    return 'analytics or telemetry'
  return pathProblem(pathTemplate)
}

/**
 * Keeps the code-only routes that can be real calls, with a query placeholder glued to the last
 * segment removed. `observedHosts` are the hosts of captured exchanges, which are kept whatever
 * they look like. Deterministic: the warning lists the dropped count and up to three examples in
 * route order. Two routes can become one; `buildOperations` already deduplicates them.
 */
export function screenSourceRoutes(routes: readonly SourceRoute[], observedHosts: ReadonlySet<string>): ScreenedRoutes {
  const kept: SourceRoute[] = []
  const dropped: string[] = []
  for (const found of routes) {
    const route = withoutGluedQuery(found)
    const problem = routeProblem(route, observedHosts)
    if (problem === null)
      kept.push(route)
    else
      dropped.push(`${quote(`${route.host ?? ''}${route.pathTemplate}`)} (${problem})`)
  }
  if (dropped.length === 0)
    return { routes: kept, warning: null }
  const shown = dropped.slice(0, 3).join(', ')
  const more = dropped.length > 3
    ? `, and ${dropped.length - 3} more`
    : ''
  return {
    routes: kept,
    warning: `Ignored ${dropped.length} endpoint${dropped.length === 1
      ? ''
      : 's'} found only in the site's code that cannot be real calls: ${shown}${more}.`,
  }
}
