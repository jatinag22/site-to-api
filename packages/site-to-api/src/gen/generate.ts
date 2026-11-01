import type { OperationEntry } from '../mcp/catalog'
import type { FlowsDocument } from '../model'
import type { ClientManifest } from './manifest'
import type { McpMode, ZodExport } from './mcp'
import type { ChannelSummary, HostSpec, OpenApiDocument } from './spec'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@hey-api/openapi-ts'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { SiteToApiError } from '../errors'
import { catalogOperations } from '../mcp/catalog'
import { trustClient } from '../trust'
import { checkGeneratedCode, heyApiInput } from './code-safety'
import { dispatchFunctions, renderDispatchModule } from './dispatch'
import { graphqlFunctions, renderGraphqlModule } from './graphql'
import { nameHtmlValues } from './html-values'
import { syncGenerated } from './manifest'
import { mcpTools, renderMcpReadme, renderMcpServer, zodExports } from './mcp'
import { nameExtracts, renderExtractModule, renderIndexModule, renderReadme } from './render'
import { AsyncApiSummarySchema, describeChannels, describeHost, OpenApiDocumentSchema, withoutBrowserOnlySteps } from './spec'

/** Input for {@link generateClient}. */
export interface GenerateClientInput {
  /** The handoff folder `build` wrote; specs are read from `specs/`, the client goes to `client/`. */
  handoffDir: string
  flows: FlowsDocument
  /**
   * `read` or `write` also writes `client/mcp/`, an MCP server with a tool per operation that
   * reads data (`read`) or per operation (`write`); `off` (the default) does not (decision 0043).
   */
  mcp?: McpMode
  /** Trust store to record the new client in (decision 0043); defaults to the person's config directory. */
  trustStore?: string
  /**
   * The files the last run generated and their hashes (`build.json`), so only those are replaced
   * or removed (decision 0057); `null` or absent for a folder from an older version.
   */
  previous?: ClientManifest | null
  /** Overwrite generated files edited by hand, and files at generated paths `gen` did not write. */
  force?: boolean
}

/** What {@link generateClient} wrote. */
export interface GenerateClientResult {
  /** Written files, relative to `handoffDir`, with `/` separators, sorted. */
  files: string[]
  /** Things the user may want to fix, e.g. a constant header with conflicting values. */
  warnings: string[]
  /** True when no spec had an API operation, so no client was written and the generated files were removed. */
  empty: boolean
  /** The generated files now in the client folder and their hashes, for `build.json`. */
  manifest: ClientManifest
}

/**
 * Generates the typed client in `<handoffDir>/client/` from `<handoffDir>/specs/*.yaml`:
 * hey-api output (types, SDK with request and response validation, Zod schemas) per host,
 * `extract.ts` with a parser per HTML/text operation and a reader per value flows.json traces to
 * an HTML page, `index.ts` wiring each host to `@site-to-api/runtime`, and a `README.md`. Every
 * relative import ends in `.js`, so the client works under `bundler` and `nodenext` resolution.
 * Everything is written into a staging folder and then copied into `client/`: only the files
 * generated (recorded with their hashes) are replaced or removed, hand-edited ones are kept and
 * reported unless `force`, and files the person put there are never touched (decision 0057).
 */
export async function generateClient(input: GenerateClientInput): Promise<GenerateClientResult> {
  const warnings: string[] = []
  const specsDir = path.join(input.handoffDir, 'specs')
  const clientDir = path.join(input.handoffDir, 'client')
  const { loaded, channels } = await loadSpecs(specsDir, warnings)

  const seen = new Map<string, string>()
  for (const { host } of loaded) {
    const other = seen.get(host.identifier)
    if (other !== undefined)
      throw new SiteToApiError(`specs/${other} and specs/${host.file} both map to client/${host.identifier}/; keep one spec per host and run \`site-to-api gen\` again`)
    seen.set(host.identifier, host.file)
  }

  const staging = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-client-'))
  try {
    // A client of no hosts does not type-check (its host union is `never`); there is nothing to
    // call, so the generated files of an earlier run are removed and nothing is written.
    if (loaded.length > 0)
      await writeClientFiles(staging, loaded, channels, input, warnings)
    const synced = await syncGenerated(staging, clientDir, input.previous ?? null, input.force === true)
    warnings.push(...synced.warnings)
    if (loaded.length === 0) {
      return {
        files: [],
        warnings,
        empty: true,
        manifest: synced.manifest,
      }
    }
    // Generated here, so this machine may run it (call_operation, the generated MCP server).
    await trustClient(clientDir, input.trustStore)
    const files = Object.keys(synced.manifest).sort().map(file => path.posix.join('client', file))
    return {
      files,
      warnings,
      empty: false,
      manifest: synced.manifest,
    }
  }
  finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Writes the whole client into `clientDir` (a staging folder) and checks the code. */
async function writeClientFiles(clientDir: string, loaded: readonly LoadedSpec[], channels: ChannelSummary[], input: GenerateClientInput, warnings: string[]): Promise<void> {
  assertTypeScript6()
  await mkdir(clientDir, { recursive: true })
  const hosts: HostSpec[] = []
  for (const { host, document } of loaded) {
    // hey-api writes some spec text into code unescaped: it gets a copy without patterns,
    // documentation and examples, and the output is checked below (decision 0043).
    await runHeyApi(OpenApiDocumentSchema.parse(heyApiInput(document)), path.join(clientDir, host.identifier), host.file)
    // GraphQL operations get a `{ variables }` function beside hey-api's (decision 0027).
    const graphql = graphqlFunctions(host, warnings)
    if (graphql.length > 0)
      await writeFile(path.join(clientDir, host.identifier, 'graphql.ts'), renderGraphqlModule(graphql))
    // Dispatcher functions get a wrapper that sends the dispatcher parameter (decision 0039).
    const dispatch = dispatchFunctions(host, warnings)
    if (dispatch.length > 0)
      await writeFile(path.join(clientDir, host.identifier, 'dispatch.ts'), renderDispatchModule(dispatch))
    hosts.push({ ...host, graphql, dispatch })
  }

  const extracts = nameExtracts(hosts, warnings)
  const htmlValues = nameHtmlValues(input.flows, new Set(extracts.map(entry => entry.functionName)), warnings)
  await writeFile(path.join(clientDir, 'extract.ts'), renderExtractModule(extracts, htmlValues))
  await writeFile(path.join(clientDir, 'index.ts'), renderIndexModule(hosts, extracts, htmlValues))
  await writeFile(path.join(clientDir, 'README.md'), renderReadme(hosts, extracts, input.flows.session, htmlValues, channels))
  if (input.mcp !== undefined && input.mcp !== 'off')
    await writeMcpServer(clientDir, loaded, input.flows, input.mcp, warnings)

  // Every file, hey-api's and our own, must parse and carry no regex literal a spec could have
  // put there; only then is the client copied into place and trusted on this machine.
  await checkGeneratedCode(clientDir)
}

interface LoadedSpec {
  host: HostSpec
  document: OpenApiDocument
}

/** `client/mcp/` (decision 0043), from the specs and the Zod schemas hey-api just wrote. */
async function writeMcpServer(clientDir: string, loaded: readonly LoadedSpec[], flows: FlowsDocument, mode: Exclude<McpMode, 'off'>, warnings: string[]): Promise<void> {
  const operations: OperationEntry[] = []
  const exportsByHost = new Map<string, Map<string, ZodExport>>()
  for (const { host, document } of loaded) {
    operations.push(...catalogOperations(host, document, host.securedOperationIds, flows, warnings))
    // hey-api writes no zod.gen.ts for a host whose operations have no schemas at all.
    const zodFile = path.join(clientDir, host.identifier, 'zod.gen.ts')
    const zodSource = existsSync(zodFile)
      ? await readFile(zodFile, 'utf8')
      : ''
    exportsByHost.set(host.host, new Map(zodExports(zodSource).map(entry => [entry.name, entry])))
  }
  const hosts = loaded.map(({ host }) => host)
  const tools = mcpTools(operations, exportsByHost, mode, warnings)
  await mkdir(path.join(clientDir, 'mcp'), { recursive: true })
  await writeFile(path.join(clientDir, 'mcp', 'server.ts'), renderMcpServer(hosts, tools, mode))
  await writeFile(path.join(clientDir, 'mcp', 'README.md'), renderMcpReadme(hosts, tools, mode))
}

function isAsyncApi(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && 'asyncapi' in raw
}

/** OpenAPI specs for hey-api, and the WebSocket channels of the AsyncAPI documents beside them. */
async function loadSpecs(specsDir: string, warnings: string[]): Promise<{ loaded: LoadedSpec[], channels: ChannelSummary[] }> {
  let names: string[]
  try {
    names = await readdir(specsDir)
  }
  catch (error) {
    throw new SiteToApiError(`No specs folder at ${specsDir}: run \`site-to-api build\` first`, { cause: error })
  }
  const specFiles = names.filter(name => /\.ya?ml$/.test(name)).sort()
  const loaded: LoadedSpec[] = []
  const channels: ChannelSummary[] = []
  let openApiCount = 0
  for (const file of specFiles) {
    const text = await readFile(path.join(specsDir, file), 'utf8')
    let raw: unknown
    try {
      raw = parseYaml(text)
    }
    catch (error) {
      throw new SiteToApiError(`specs/${file} is not valid YAML; run \`site-to-api build\` again`, { cause: error })
    }
    if (isAsyncApi(raw)) {
      const asyncApi = AsyncApiSummarySchema.safeParse(raw)
      if (asyncApi.success)
        channels.push(...describeChannels(file, asyncApi.data))
      else
        warnings.push(`specs/${file} looks like AsyncAPI but could not be read (${z.prettifyError(asyncApi.error).replaceAll('\n', '; ')}); client/README.md does not list its channels.`)
      continue
    }
    const parsed = OpenApiDocumentSchema.safeParse(raw)
    if (!parsed.success)
      throw new SiteToApiError(`specs/${file} is not an OpenAPI document (${z.prettifyError(parsed.error).replaceAll('\n', '; ')}); run \`site-to-api build\` again`)
    openApiCount++
    const document = withoutBrowserOnlySteps(parsed.data)
    if (document === null)
      continue
    loaded.push({
      host: describeHost(file, document, warnings),
      document,
    })
  }
  if (openApiCount === 0)
    throw new SiteToApiError(`No .yaml specs (OpenAPI) in ${specsDir}: run \`site-to-api build\` first`)
  return { loaded, channels }
}

async function runHeyApi(document: OpenApiDocument, output: string, file: string): Promise<void> {
  try {
    await createClient({
      input: document,
      // `.js` specifiers resolve under both `bundler` and `nodenext`, and in compiled output that
      // plain Node runs; extensionless ones only work with a bundler.
      output: {
        path: output,
        module: { extension: '.js' },
      },
      plugins: [
        '@hey-api/client-fetch',
        {
          name: 'zod',
          // Pinned so the output does not depend on the zod version found in the user's project.
          compatibilityVersion: 4,
          // Sites send date-times with offsets (`-05:00`) and without a zone; Zod's default
          // accepts only `Z`, so valid live data failed response validation.
          dates: { offset: true, local: true },
          $resolvers: {
            validator: {
              // hey-api validates the resolved request options, whose `headers` is a `Headers`
              // instance that a Zod object cannot read: every required header failed. The
              // runtime turns it into a plain object first.
              request: ({ $, operation, plugin, symbols }) => {
                const helper = plugin.symbolOnce('requestValidationInput', { external: '@site-to-api/runtime' })
                const mixedCase = Object.values(operation.parameters?.header ?? {})
                  .map(parameter => parameter.name)
                  .filter(name => name !== name.toLowerCase())
                  .sort()
                const input = mixedCase.length === 0
                  ? $(helper).call('data')
                  : $(helper).call('data', $.fromValue(mixedCase))
                return $(symbols.schema).attr('parseAsync').call(input).await().return()
              },
            },
          },
        },
        { name: '@hey-api/sdk', validator: true },
      ],
      // No log files in the user's working directory; failures surface as the error below.
      logs: { level: 'silent', file: false },
    })
  }
  catch (error) {
    throw new SiteToApiError(`hey-api could not generate a client from specs/${file}: ${error instanceof Error
      ? error.message
      : String(error)}`, { cause: error })
  }
}

const PackageVersionSchema = z.object({
  version: z.string(),
})

/**
 * hey-api drives the TypeScript compiler API, which TypeScript 7 removed (decision 0002). A
 * package manager may still hand hey-api a different TypeScript than the one `site-to-api`
 * depends on, so check the copy hey-api itself resolves.
 */
export function typeScriptVersionForHeyApi(): string {
  const requireFromHeyApi = createRequire(import.meta.resolve('@hey-api/openapi-ts'))
  const manifest = PackageVersionSchema.parse(JSON.parse(readFileSync(requireFromHeyApi.resolve('typescript/package.json'), 'utf8')))
  return manifest.version
}

function assertTypeScript6(): void {
  const version = typeScriptVersionForHeyApi()
  if (!version.startsWith('6.'))
    throw new SiteToApiError(`hey-api found TypeScript ${version}, but code generation needs TypeScript 6. Install typescript@6 next to site-to-api (for example \`npm install -D typescript@6\`) and run \`site-to-api gen\` again`)
}
