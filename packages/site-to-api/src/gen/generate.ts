import type { FlowsDocument } from '../model'
import type { ChannelSummary, HostSpec, OpenApiDocument } from './spec'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createClient } from '@hey-api/openapi-ts'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { SiteToApiError } from '../errors'
import { nameHtmlValues } from './html-values'
import { nameExtracts, renderExtractModule, renderIndexModule, renderReadme } from './render'
import { AsyncApiSummarySchema, describeChannels, describeHost, OpenApiDocumentSchema } from './spec'

/** Input for {@link generateClient}. */
export interface GenerateClientInput {
  /** The handoff folder `build` wrote; specs are read from `specs/`, the client goes to `client/`. */
  handoffDir: string
  flows: FlowsDocument
}

/** What {@link generateClient} wrote. */
export interface GenerateClientResult {
  /** Written files, relative to `handoffDir`, with `/` separators, sorted. */
  files: string[]
  /** Things the user may want to fix, e.g. a constant header with conflicting values. */
  warnings: string[]
}

/**
 * Generates the typed client in `<handoffDir>/client/` from `<handoffDir>/specs/*.yaml`:
 * hey-api output (types, SDK with request and response validation, Zod schemas) per host,
 * `extract.ts` with a parser per HTML/text operation and a reader per value flows.json traces to
 * an HTML page, `index.ts` wiring each host to `@site-to-api/runtime`, and a `README.md`. Every
 * relative import ends in `.js`, so the client works under `bundler` and `nodenext` resolution.
 * The `client/` folder is replaced on every run, so stale hosts do not linger.
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

  assertTypeScript6()
  await rm(clientDir, { recursive: true, force: true })
  await mkdir(clientDir, { recursive: true })
  for (const { host, document } of loaded)
    await runHeyApi(document, path.join(clientDir, host.identifier), host.file)

  const hosts = loaded.map(entry => entry.host)
  const extracts = nameExtracts(hosts, warnings)
  const htmlValues = nameHtmlValues(input.flows, new Set(extracts.map(entry => entry.functionName)), warnings)
  await writeFile(path.join(clientDir, 'extract.ts'), renderExtractModule(extracts, htmlValues))
  await writeFile(path.join(clientDir, 'index.ts'), renderIndexModule(hosts, extracts, htmlValues))
  await writeFile(path.join(clientDir, 'README.md'), renderReadme(hosts, extracts, input.flows.session, htmlValues, channels))

  const files = (await listFiles(clientDir)).map(file => path.posix.join('client', file))
  return { files, warnings }
}

interface LoadedSpec {
  host: HostSpec
  document: OpenApiDocument
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
    loaded.push({
      host: describeHost(file, parsed.data, warnings),
      document: parsed.data,
    })
  }
  if (loaded.length === 0)
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

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}
