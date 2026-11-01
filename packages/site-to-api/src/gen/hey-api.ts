/**
 * Loads hey-api (`@hey-api/openapi-ts`) for `gen` only, with site-to-api's own TypeScript.
 *
 * hey-api drives the TypeScript compiler API, which TypeScript 7 removed (decision 0002), and
 * declares `typescript` as a peer (`>=5.5.3`). npm dedupes that peer onto the project's own
 * TypeScript, so a project with TypeScript 7 made hey-api load TS 7 and the whole CLI crash at
 * start (`Cannot read properties of undefined (reading 'AnyKeyword')`). So hey-api is imported
 * lazily, only when a client is generated, and before that a module resolve hook points every
 * `typescript` import from hey-api's packages at the TypeScript site-to-api itself depends on.
 * pnpm already gives hey-api that copy; the hook changes nothing there.
 */
import type * as HeyApi from '@hey-api/openapi-ts'
import { readFileSync } from 'node:fs'
import { createRequire, register } from 'node:module'
import { z } from 'zod'
import { SiteToApiError } from '../errors'

const PackageVersionSchema = z.object({
  version: z.string(),
})

/** The `typescript` site-to-api depends on, as a file URL. */
function ownTypeScript(): string {
  return import.meta.resolve('typescript')
}

/** The version of the TypeScript hey-api is given: site-to-api's own. */
export function typeScriptVersionForHeyApi(): string {
  const manifest = createRequire(import.meta.url).resolve('typescript/package.json')
  return PackageVersionSchema.parse(JSON.parse(readFileSync(manifest, 'utf8'))).version
}

/**
 * The resolve hook, as module source. Only `typescript` imported from a file under a
 * `@hey-api/` package folder is redirected; every other import resolves as before.
 */
export function redirectHookSource(target: string): string {
  return `export async function resolve(specifier, context, next) {
  if (specifier === 'typescript' && typeof context.parentURL === 'string' && context.parentURL.includes('/@hey-api/'))
    return { url: ${JSON.stringify(target)}, format: 'commonjs', shortCircuit: true }
  return next(specifier, context)
}
`
}

let loading: Promise<typeof HeyApi> | null = null

/**
 * hey-api, loaded once with site-to-api's TypeScript. Throws {@link SiteToApiError} when that
 * TypeScript is not 6 or hey-api cannot be loaded, saying what to do; other commands never load it.
 */
export async function loadHeyApi(): Promise<typeof HeyApi> {
  loading ??= (async () => {
    const version = typeScriptVersionForHeyApi()
    if (!version.startsWith('6.'))
      throw new SiteToApiError(`site-to-api found TypeScript ${version} for code generation, which needs TypeScript 6 (TypeScript 7 has no compiler API). Reinstall site-to-api so it gets its own typescript@6 (for example \`npm install -D site-to-api\`), then run \`site-to-api gen\` again.`)
    register(`data:text/javascript,${encodeURIComponent(redirectHookSource(ownTypeScript()))}`)
    try {
      return await import('@hey-api/openapi-ts')
    }
    catch (error) {
      throw new SiteToApiError(`Could not load the client generator (@hey-api/openapi-ts): ${error instanceof Error
        ? error.message
        : String(error)}. Reinstall site-to-api (for example \`npm install -D site-to-api\`); if it still fails, report it with the output of \`npm ls typescript @hey-api/openapi-ts\`.`, { cause: error })
    }
  })()
  try {
    return await loading
  }
  catch (error) {
    loading = null
    throw error
  }
}
