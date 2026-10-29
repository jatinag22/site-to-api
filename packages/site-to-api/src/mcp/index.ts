import type { ExplorationServerOptions } from './server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createCaller } from './call'
import { loadHandoff } from './handoff'
import { createExplorationServer } from './server'

/** Options for {@link serveHandoff}. */
export interface ServeHandoffOptions {
  handoffDir: string
  allowCalls: boolean
  unsafeMethods: boolean
  maxRps: number
  timeoutMs: number
  env: Record<string, string | undefined>
  /** Where to report problems; stdout carries the protocol, so the CLI passes stderr. */
  log: (message: string) => void
}

/**
 * Serves the handoff folder over stdio until the client closes the connection. Resolves once the
 * folder is loaded and the server is listening; the returned function stops it.
 */
export async function serveHandoff(options: ServeHandoffOptions): Promise<() => Promise<void>> {
  const handoff = await loadHandoff(options.handoffDir)
  for (const warning of handoff.warnings)
    options.log(warning)
  const serverOptions: ExplorationServerOptions = {
    handoff,
    allowCalls: options.allowCalls,
    unsafeMethods: options.unsafeMethods,
    maxRps: options.maxRps,
    ...(options.allowCalls
      ? {
          call: createCaller({
            handoff,
            maxRps: options.maxRps,
            timeoutMs: options.timeoutMs,
            env: options.env,
          }),
        }
      : {}),
  }
  const handle = serveStdio(() => createExplorationServer(serverOptions))
  options.log(`site-to-api MCP server: ${handoff.operations.length} operations on ${handoff.hosts.length} host(s) from ${options.handoffDir}${options.allowCalls
    ? `; call_operation on (${options.unsafeMethods
      ? 'writes allowed'
      : 'reads only'}, ${options.maxRps} request(s)/s)`
    : ''}`)
  return () => handle.close()
}
