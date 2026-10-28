/**
 * Reads what `gen` needs from a host spec written by `build` (docs/output-format.md): the base
 * URL, constant headers and the extraction specs of HTML/text operations. Pure: the caller
 * reads the file.
 */
import type { ExtractSpec } from '@site-to-api/runtime'
import { z } from 'zod'

const FieldTypeSchema = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'date',
])

/** Validates `x-site-to-api-extract` against the runtime's {@link ExtractSpec}. */
const ExtractSpecSchema: z.ZodType<ExtractSpec> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('html'),
    records: z.string(),
    many: z.boolean(),
    fields: z.record(z.string(), z.object({
      selector: z.string(),
      attr: z.string().nullable(),
      pattern: z.string().nullable(),
      type: FieldTypeSchema,
      optional: z.boolean(),
    })),
  }),
  z.object({
    kind: z.literal('text'),
    layout: z.enum(['delimited', 'pattern']),
    delimiter: z.string().nullable(),
    header: z.boolean(),
    pattern: z.string().nullable(),
    fields: z.record(z.string(), z.object({
      column: z.number().int().min(0).nullable(),
      group: z.string().nullable(),
      type: FieldTypeSchema,
      optional: z.boolean(),
    })),
  }),
])

const RefSchema = z.looseObject({
  $ref: z.string(),
})

const ParameterSchema = z.looseObject({
  'name': z.string(),
  'in': z.string(),
  'schema': z.looseObject({
    default: z.unknown().optional(),
  }).optional(),
  'x-site-to-api-constant': z.boolean().optional(),
})

const MediaTypeSchema = z.looseObject({
  'x-site-to-api-extract': z.unknown().optional(),
})

const ResponseSchema = z.looseObject({
  content: z.record(z.string(), MediaTypeSchema).optional(),
})

// Parameters and responses are checked one by one later, so one odd entry (a `$ref`, an
// extension) does not reject the whole spec.
const SecurityRequirementsSchema = z.array(z.record(z.string(), z.unknown()))

const OperationSchema = z.looseObject({
  'operationId': z.string().optional(),
  // `api`, `page` or `bot-protection` (emit/openapi); bot-protection steps get no client method.
  'x-site-to-api-kind': z.string().optional(),
  'security': SecurityRequirementsSchema.optional(),
  // What `probe` found this operation needs (`cookie:<name>`, ...); absent when not minimized.
  'x-site-to-api-requires': z.array(z.string()).optional(),
  'parameters': z.array(z.unknown()).optional(),
  'responses': z.record(z.string(), z.unknown()).optional(),
})

const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const

const PathItemSchema = z.looseObject({
  parameters: z.array(z.unknown()).optional(),
  get: OperationSchema.optional(),
  put: OperationSchema.optional(),
  post: OperationSchema.optional(),
  delete: OperationSchema.optional(),
  options: OperationSchema.optional(),
  head: OperationSchema.optional(),
  patch: OperationSchema.optional(),
  trace: OperationSchema.optional(),
})

const SecuritySchemeSchema = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  in: z.string().optional(),
  scheme: z.string().optional(),
})

/** The parts of an OpenAPI 3.1 document `gen` reads; everything else passes through. */
export const OpenApiDocumentSchema = z.looseObject({
  openapi: z.string(),
  security: SecurityRequirementsSchema.optional(),
  components: z.looseObject({
    securitySchemes: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  servers: z.array(z.looseObject({
    url: z.string(),
  })).optional(),
  paths: z.record(z.string(), PathItemSchema).optional(),
})
export type OpenApiDocument = z.infer<typeof OpenApiDocumentSchema>

/**
 * The parts of a `specs/<host>.asyncapi.yaml` document (written by `build`) that the client
 * README mentions. hey-api generates HTTP clients only, so channels are documented, not generated.
 */
export const AsyncApiSummarySchema = z.object({
  asyncapi: z.string(),
  servers: z.record(z.string(), z.object({
    host: z.string(),
    protocol: z.string(),
  })),
  channels: z.record(z.string(), z.object({
    'address': z.string(),
    'servers': z.array(z.object({
      $ref: z.string(),
    })).default([]),
    'messages': z.record(z.string(), z.object({
      name: z.string().optional(),
    })).default({}),
    'x-site-to-api-handshake': z.array(z.object({
      message: z.string(),
      example: z.unknown(),
    })).default([]),
  })),
})

/** One WebSocket channel as the client README describes it. */
export interface ChannelSummary {
  /** `specs/` file it was read from. */
  file: string
  id: string
  /** `ws://host/path`. */
  url: string
  /** Messages to send right after connecting, with a redacted example (null when none was written). */
  handshake: Array<{ name: string, example: unknown }>
}

/** Channels of one parsed AsyncAPI document, in document order. */
export function describeChannels(file: string, document: z.infer<typeof AsyncApiSummarySchema>): ChannelSummary[] {
  return Object.entries(document.channels).map(([id, channel]) => {
    const serverName = channel.servers[0]?.$ref.split('/').at(-1)
    const server = (serverName === undefined
      ? undefined
      : document.servers[serverName]) ?? Object.values(document.servers)[0]
    const url = server
      ? `${server.protocol}://${server.host}${channel.address}`
      : channel.address
    return {
      file,
      id,
      url,
      handshake: channel['x-site-to-api-handshake'].map(step => ({
        name: channel.messages[step.message]?.name ?? step.message,
        example: step.example ?? null,
      })),
    }
  })
}

type Parameter = z.infer<typeof ParameterSchema>
type Operation = z.infer<typeof OperationSchema>

/** An operation whose HTML or text response has an extraction spec. */
export interface ExtractOperation {
  operationId: string
  method: string
  path: string
  status: string
  mimeType: string
  spec: ExtractSpec
}

/** A security scheme from `components.securitySchemes`, as the generated client applies it. */
export interface AuthScheme {
  /** Key in `components.securitySchemes`. */
  name: string
  /** `apiKey` (sent as-is), `http` (`bearer` adds `Bearer `, `basic` encodes) or another type. */
  type: string
  /** `header`, `query` or `cookie` for `apiKey`; null otherwise. */
  in: string | null
  /** Header, query or cookie name for `apiKey`; null otherwise. */
  parameter: string | null
  /** `bearer`, `basic`, ... for `http`; null otherwise. */
  scheme: string | null
}

/** Everything `gen` writes for one host spec. */
export interface HostSpec {
  /** Spec file name inside `specs/`. */
  file: string
  /** Host (with port when not the default), e.g. `shop.example.com`. */
  host: string
  /** Folder under `client/` and the namespace exported from `client/index.ts`. */
  identifier: string
  baseUrl: string
  /** Headers with `x-site-to-api-constant: true` and a default, sent on every request. */
  defaultHeaders: Record<string, string>
  operationIds: string[]
  extracts: ExtractOperation[]
  /** Security schemes the spec declares, sorted by name. */
  auth: AuthScheme[]
  /** Operations that declare a security requirement (theirs or the document's), sorted. */
  securedOperationIds: string[]
  /**
   * `x-site-to-api-requires` of every operation `probe` minimized, so the client README can say
   * which cookies probe confirmed (see emit/cookies). Empty before probing.
   */
  probedRequires: string[][]
}

/**
 * The document without its bot-protection steps (`x-site-to-api-kind: bot-protection`), which
 * only a real browser may run (decision 0008): a client method for them would invite replaying a
 * challenge. `null` when nothing else is left, so the host gets no client folder at all.
 */
export function withoutBrowserOnlySteps(document: OpenApiDocument): OpenApiDocument | null {
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const kept = { ...item }
    for (const method of METHODS) {
      if (kept[method]?.['x-site-to-api-kind'] === 'bot-protection')
        delete kept[method]
    }
    if (METHODS.some(method => kept[method] !== undefined))
      paths[path] = kept
  }
  if (Object.keys(paths).length === 0 && Object.keys(document.paths ?? {}).length > 0)
    return null
  return { ...document, paths }
}

/** `x-site-to-api-requires` of every operation that has one, in spec order. */
function probedRequiresOf(document: OpenApiDocument): string[][] {
  return Object.values(document.paths ?? {}).flatMap(item => METHODS.flatMap((method) => {
    const requires = item[method]?.['x-site-to-api-requires']
    return requires
      ? [requires]
      : []
  }))
}

/**
 * Describes one host spec. Problems that only lose a convenience (a constant header with two
 * values, an unreadable extraction spec) become warnings; the client is still generated.
 */
export function describeHost(file: string, document: OpenApiDocument, warnings: string[]): HostSpec {
  const { host, baseUrl } = resolveServer(file, document, warnings)
  const headerValues = new Map<string, Set<string>>()
  const operationIds: string[] = []
  const securedOperationIds: string[] = []
  const extracts: ExtractOperation[] = []
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method]
      if (!operation)
        continue
      const where = `specs/${file}: ${method.toUpperCase()} ${path}`
      if (operation.operationId === undefined) {
        warnings.push(`${where} has no operationId; its SDK function is named by hey-api and it gets no extract parser`)
        continue
      }
      operationIds.push(operation.operationId)
      // An empty list (`security: []`) is how an operation opts out of the document's default.
      if ((operation.security ?? document.security ?? []).some(requirement => Object.keys(requirement).length > 0))
        securedOperationIds.push(operation.operationId)
      collectConstantHeaders([
        ...(item.parameters ?? []),
        ...(operation.parameters ?? []),
      ], headerValues, where, warnings)
      const extract = findExtract(operation, where, warnings)
      if (extract) {
        extracts.push({
          operationId: operation.operationId,
          method: method.toUpperCase(),
          path,
          ...extract,
        })
      }
    }
  }

  return {
    file,
    host,
    identifier: toIdentifier(host),
    baseUrl,
    defaultHeaders: settleHeaders(headerValues, file, warnings),
    operationIds: operationIds.sort(),
    extracts: extracts.sort((a, b) => a.operationId.localeCompare(b.operationId)),
    auth: readAuthSchemes(file, document, warnings),
    securedOperationIds: securedOperationIds.sort(),
    probedRequires: probedRequiresOf(document),
  }
}

function readAuthSchemes(file: string, document: OpenApiDocument, warnings: string[]): AuthScheme[] {
  const schemes: AuthScheme[] = []
  const entries = Object.entries(document.components?.securitySchemes ?? {}).sort(([a], [b]) => a.localeCompare(b))
  for (const [name, raw] of entries) {
    const parsed = SecuritySchemeSchema.safeParse(raw)
    if (!parsed.success) {
      warnings.push(`specs/${file}: security scheme ${name} has no type and is not described in the client README`)
      continue
    }
    const scheme = parsed.data
    schemes.push({
      name,
      type: scheme.type,
      in: scheme.type === 'apiKey'
        ? scheme.in ?? null
        : null,
      parameter: scheme.type === 'apiKey'
        ? scheme.name ?? null
        : null,
      scheme: scheme.type === 'http'
        ? scheme.scheme?.toLowerCase() ?? null
        : null,
    })
  }
  return schemes
}

/** The host and base URL from `servers[0]`, falling back to the spec file name. */
function resolveServer(file: string, document: OpenApiDocument, warnings: string[]): { host: string, baseUrl: string } {
  const fallbackHost = file.replace(/\.ya?ml$/, '')
  const fallback = { host: fallbackHost, baseUrl: `https://${fallbackHost}` }
  const server = document.servers?.[0]?.url
  if (server === undefined) {
    warnings.push(`specs/${file}: no servers entry; using ${fallback.baseUrl} as the base URL`)
    return fallback
  }
  const url = URL.parse(server)
  if (url === null || url.host === '') {
    warnings.push(`specs/${file}: server URL ${JSON.stringify(server)} is not absolute; using ${fallback.baseUrl} as the base URL`)
    return fallback
  }
  return {
    host: url.host,
    baseUrl: server.replace(/\/+$/, ''),
  }
}

function collectConstantHeaders(parameters: unknown[], values: Map<string, Set<string>>, where: string, warnings: string[]): void {
  for (const raw of parameters) {
    const parameter = ParameterSchema.safeParse(raw)
    if (parameter.success) {
      collectConstantHeader(parameter.data, values)
      continue
    }
    const ref = RefSchema.safeParse(raw)
    warnings.push(ref.success
      ? `${where}: parameter ${ref.data.$ref} is a reference; constant headers are only read from inline parameters`
      : `${where}: a parameter has no name or location and is ignored`)
  }
}

/** Headers that name the page a request came from: differing per operation is normal, not worth a warning. */
const PER_PAGE_HEADERS: ReadonlySet<string> = new Set(['referer', 'origin'])

/** Headers with a single default across the host; a header with several is left to the caller. */
function settleHeaders(values: Map<string, Set<string>>, file: string, warnings: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, set] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
    const all = [...set].sort()
    if (all.length === 1 && all[0] !== undefined)
      headers[name] = all[0]
    else if (!PER_PAGE_HEADERS.has(name.toLowerCase()))
      warnings.push(`specs/${file}: constant header ${name} has different defaults across operations (${all.join(', ')}); it is not sent by default`)
  }
  return headers
}

function collectConstantHeader(data: Parameter, values: Map<string, Set<string>>): void {
  const value = data.schema?.default
  if (data.in !== 'header' || data['x-site-to-api-constant'] !== true)
    return
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
    return
  const name = data.name.toLowerCase()
  const set = values.get(name) ?? new Set<string>()
  set.add(String(value))
  values.set(name, set)
}

/** The first success response (lowest status) with an HTML or text body and an extract spec. */
function findExtract(operation: Operation, where: string, warnings: string[]): Omit<ExtractOperation, 'operationId' | 'method' | 'path'> | null {
  const responses = Object.entries(operation.responses ?? {}).sort(([a], [b]) => a.localeCompare(b))
  for (const [status, response] of responses) {
    if (!status.startsWith('2'))
      continue
    const content = ResponseSchema.safeParse(response).data?.content ?? {}
    for (const [mimeType, media] of Object.entries(content).sort(([a], [b]) => a.localeCompare(b))) {
      const raw = media['x-site-to-api-extract']
      if (raw === undefined)
        continue
      if (!mimeType.startsWith('text/')) {
        warnings.push(`${where}: x-site-to-api-extract on ${mimeType} is ignored; it applies to HTML and text responses`)
        continue
      }
      const spec = ExtractSpecSchema.safeParse(raw)
      if (!spec.success) {
        warnings.push(`${where}: x-site-to-api-extract is not a valid extraction spec (${z.prettifyError(spec.error).replaceAll('\n', '; ')}); run \`site-to-api build\` again`)
        continue
      }
      return { status, mimeType, spec: spec.data }
    }
  }
  return null
}

/**
 * Words that cannot name an import binding (`import * as default` is a syntax error), plus the
 * module-level names `client/index.ts` declares itself. A host such as `http://new/` would
 * otherwise produce one of them.
 */
const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'sdks',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

/** `shop.example.com:8080` → `shop_example_com_8080`, a valid identifier and folder name. */
export function toIdentifier(host: string): string {
  const id = host.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (/^\d/.test(id) || id === '')
    return `_${id}`
  return RESERVED_IDENTIFIERS.has(id)
    ? `${id}_`
    : id
}

/** `getApiItem` → `GetApiItem`, `get-api_item` → `GetApiItem`. */
export function toPascalCase(value: string): string {
  return value
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}
