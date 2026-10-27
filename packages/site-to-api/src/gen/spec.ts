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
const OperationSchema = z.looseObject({
  operationId: z.string().optional(),
  parameters: z.array(z.unknown()).optional(),
  responses: z.record(z.string(), z.unknown()).optional(),
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

/** The parts of an OpenAPI 3.1 document `gen` reads; everything else passes through. */
export const OpenApiDocumentSchema = z.looseObject({
  openapi: z.string(),
  servers: z.array(z.looseObject({
    url: z.string(),
  })).optional(),
  paths: z.record(z.string(), PathItemSchema).optional(),
})
export type OpenApiDocument = z.infer<typeof OpenApiDocumentSchema>

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
}

/**
 * Describes one host spec. Problems that only lose a convenience (a constant header with two
 * values, an unreadable extraction spec) become warnings; the client is still generated.
 */
export function describeHost(file: string, document: OpenApiDocument, warnings: string[]): HostSpec {
  const { host, baseUrl } = resolveServer(file, document, warnings)
  const headerValues = new Map<string, Set<string>>()
  const operationIds: string[] = []
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
  }
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

/** `shop.example.com:8080` → `shop_example_com_8080`, a valid identifier and folder name. */
export function toIdentifier(host: string): string {
  const id = host.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return /^\d/.test(id) || id === ''
    ? `_${id}`
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
