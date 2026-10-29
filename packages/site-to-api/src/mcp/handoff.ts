/**
 * Reads a handoff folder for the MCP server (decision 0043): the specs, `flows.json`,
 * `build.json` and the names of the excerpts under `source/`. Nothing else is opened, and never
 * the raw captures: everything the server can show an agent is what `build` already redacted.
 */
import type { BuildRecord } from '../build/record'
import type { AuthScheme, ChannelSummary, OpenApiDocument } from '../gen/spec'
import type { FlowsDocument } from '../model'
import type { OperationEntry } from './catalog'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'pathe'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { readBuildRecord } from '../build/record'
import { SiteToApiError } from '../errors'
import { AsyncApiSummarySchema, describeChannels, describeHost, OpenApiDocumentSchema } from '../gen/spec'
import { FlowsDocumentSchema } from '../model'
import { catalogOperations } from './catalog'

/** One OpenAPI spec of the folder. */
export interface HandoffHost {
  /** File name inside `specs/`. */
  file: string
  host: string
  /** Folder under `client/` and the identifier in environment variable names. */
  identifier: string
  baseUrl: string
  /** AsyncAPI file of the same host, when the capture had WebSocket channels. */
  asyncApiFile: string | null
  /** Security schemes of the spec (names and where the credential goes, never a value). */
  auth: AuthScheme[]
}

/** What the server knows about a handoff folder. */
export interface Handoff {
  dir: string
  hosts: HandoffHost[]
  operations: OperationEntry[]
  channels: ChannelSummary[]
  flows: FlowsDocument
  /** `build.json`, or null for a folder written before it existed. */
  build: BuildRecord | null
  /** Excerpt files relative to the folder (`source/src/auth/crypto.L18-28.ts.md`), sorted. */
  excerpts: string[]
  /** `client/index.ts` exists, so calls can go through the generated client. */
  clientGenerated: boolean
  /** Problems that only lose detail; the server still starts. */
  warnings: string[]
}

async function readJson(path: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new SiteToApiError(`${path} is not valid JSON (${what}). Run \`site-to-api build\` to rewrite the handoff folder.`, { cause: error })
  }
}

async function readFlows(dir: string): Promise<FlowsDocument> {
  const path = join(dir, 'flows.json')
  if (!existsSync(path))
    throw new SiteToApiError(`${path} not found: ${dir} is not a handoff folder. Run \`site-to-api build\` first, or pass --out-dir with the folder build wrote.`)
  const parsed = FlowsDocumentSchema.safeParse(await readJson(path, 'flows'))
  if (!parsed.success)
    throw new SiteToApiError(`${path} does not match the flows format of this version. Run \`site-to-api build\` to rewrite it.`)
  return parsed.data
}

async function listExcerpts(dir: string): Promise<string[]> {
  const sourceDir = join(dir, 'source')
  if (!existsSync(sourceDir))
    return []
  const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}

interface ParsedSpecs {
  openApi: Array<{ file: string, document: OpenApiDocument }>
  asyncApi: Array<{ file: string, channels: ChannelSummary[] }>
}

async function readSpecs(dir: string, warnings: string[]): Promise<ParsedSpecs> {
  const specsDir = join(dir, 'specs')
  if (!existsSync(specsDir))
    throw new SiteToApiError(`No specs folder in ${dir}. Run \`site-to-api build\` first.`)
  const files = (await readdir(specsDir)).filter(name => /\.ya?ml$/.test(name)).sort()
  const result: ParsedSpecs = { openApi: [], asyncApi: [] }
  for (const file of files) {
    let raw: unknown
    try {
      raw = parseYaml(await readFile(join(specsDir, file), 'utf8'))
    }
    catch (error) {
      throw new SiteToApiError(`specs/${file} is not valid YAML; run \`site-to-api build\` again.`, { cause: error })
    }
    if (typeof raw === 'object' && raw !== null && 'asyncapi' in raw) {
      const parsed = AsyncApiSummarySchema.safeParse(raw)
      if (parsed.success) {
        result.asyncApi.push({
          file,
          channels: describeChannels(file, parsed.data),
        })
      }
      else {
        warnings.push(`specs/${file} looks like AsyncAPI but could not be read; its channels are not listed.`)
      }
      continue
    }
    const parsed = OpenApiDocumentSchema.safeParse(raw)
    if (!parsed.success)
      throw new SiteToApiError(`specs/${file} is not an OpenAPI document (${z.prettifyError(parsed.error).replaceAll('\n', '; ')}); run \`site-to-api build\` again.`)
    result.openApi.push({ file, document: parsed.data })
  }
  if (result.openApi.length === 0)
    throw new SiteToApiError(`No OpenAPI specs in ${specsDir}. Run \`site-to-api build\` first.`)
  return result
}

/** Reads the handoff folder `dir`. Throws a {@link SiteToApiError} when it is not one. */
export async function loadHandoff(dir: string): Promise<Handoff> {
  const warnings: string[] = []
  const flows = await readFlows(dir)
  const specs = await readSpecs(dir, warnings)
  const hosts: HandoffHost[] = []
  const operations: OperationEntry[] = []
  for (const { file, document } of specs.openApi) {
    const described = describeHost(file, document, warnings)
    const asyncApiFile = file.replace(/\.ya?ml$/, '.asyncapi.yaml')
    const host: HandoffHost = {
      file,
      host: described.host,
      identifier: described.identifier,
      baseUrl: described.baseUrl,
      asyncApiFile: specs.asyncApi.some(entry => entry.file === asyncApiFile)
        ? asyncApiFile
        : null,
      auth: described.auth,
    }
    hosts.push(host)
    operations.push(...catalogOperations(host, document, described.securedOperationIds, flows, warnings))
  }
  return {
    dir,
    hosts,
    operations,
    channels: specs.asyncApi.flatMap(entry => entry.channels),
    flows,
    build: await readBuildRecord(dir),
    excerpts: await listExcerpts(dir),
    clientGenerated: existsSync(join(dir, 'client', 'index.ts')),
    warnings,
  }
}

/** The text of one excerpt; `path` must be one of {@link Handoff.excerpts}, so nothing else is readable. */
export async function readExcerpt(handoff: Handoff, path: string): Promise<string | null> {
  if (!handoff.excerpts.includes(path))
    return null
  return readFile(join(handoff.dir, path), 'utf8')
}
