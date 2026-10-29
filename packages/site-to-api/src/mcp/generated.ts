/**
 * `site-to-api mcp --generated`: runs `client/mcp/server.ts`, the per-site server `gen --mcp`
 * wrote, from the installed CLI (decision 0043). The file is code from the handoff folder, so it
 * runs only after the trust check: the whole `client/` must hash to what this machine's `gen`
 * recorded, unless the person passed `--trust-client`. Running the file directly (`tsx
 * client/mcp/server.ts`) skips that check.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { join } from 'pathe'
import { SiteToApiError } from '../errors'
import { untrustedReason } from '../trust'

/** Options for {@link serveGenerated}. */
export interface ServeGeneratedOptions {
  handoffDir: string
  trustClient: boolean
  trustStore?: string
}

/** Generated code imports these; they resolve to the copies this tool runs with. */
function aliases(): Record<string, string> {
  const resolved = (specifier: string): string => fileURLToPath(import.meta.resolve(specifier))
  return {
    // The subpath first: an alias for the package would otherwise swallow it.
    '@modelcontextprotocol/server/stdio': resolved('@modelcontextprotocol/server/stdio'),
    '@modelcontextprotocol/server': resolved('@modelcontextprotocol/server'),
    '@site-to-api/runtime': resolved('@site-to-api/runtime'),
    'zod': resolved('zod'),
  }
}

/** Checks the client and runs its server, which serves stdio until the client disconnects. */
export async function serveGenerated(options: ServeGeneratedOptions): Promise<void> {
  const server = join(options.handoffDir, 'client', 'mcp', 'server.ts')
  if (!existsSync(server))
    throw new SiteToApiError(`No generated MCP server at ${server}: run \`site-to-api gen --mcp\` first.`)
  if (!options.trustClient) {
    const reason = await untrustedReason(join(options.handoffDir, 'client'), options.trustStore)
    if (reason !== null)
      throw new SiteToApiError(reason)
  }
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: aliases(),
  })
  await jiti.import(server)
}
