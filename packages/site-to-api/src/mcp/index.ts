import type { CallArguments, CallOutcome } from './call'
import type { OperationEntry } from './catalog'
import type { Handoff } from './handoff'
import type { ExplorationServerOptions } from './server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createCaller } from './call'
import { createExplorationServer } from './server'
import { createHandoffSource } from './source'

/** Options for {@link serveHandoff}. */
export interface ServeHandoffOptions {
  handoffDir: string
  allowCalls: boolean
  unsafeMethods: boolean
  maxRps: number
  timeoutMs: number
  env: Record<string, string | undefined>
  /** `--trust-client`: run a `client/` this machine did not generate (decision 0043). */
  trustClient: boolean
  /** The project root for the trust check: the config file's folder or the working directory. */
  projectRoot?: string
  /** Where to report problems; stdout carries the protocol, so the CLI passes stderr. */
  log: (message: string) => void
}

/**
 * Serves the handoff folder over stdio until the client closes the connection. The folder need
 * not exist yet: tools say how to make it and pick it up once `build` has written it. Resolves
 * once the server is listening; the returned function stops it.
 */
export async function serveHandoff(options: ServeHandoffOptions): Promise<() => Promise<void>> {
  const load = createHandoffSource(options.handoffDir, options.log)
  // One caller per loaded folder: a rebuild may change the hosts, specs and generated client.
  const callers = new WeakMap<Handoff, ReturnType<typeof createCaller>>()
  const call = (handoff: Handoff, entry: OperationEntry, args: CallArguments): Promise<CallOutcome> => {
    const caller = callers.get(handoff) ?? createCaller({
      handoff,
      maxRps: options.maxRps,
      timeoutMs: options.timeoutMs,
      env: options.env,
      trustClient: options.trustClient,
      ...(options.projectRoot === undefined
        ? {}
        : { projectRoot: options.projectRoot }),
    })
    callers.set(handoff, caller)
    return caller(entry, args)
  }
  const serverOptions: ExplorationServerOptions = {
    load,
    allowCalls: options.allowCalls,
    unsafeMethods: options.unsafeMethods,
    maxRps: options.maxRps,
    ...(options.allowCalls
      ? { call }
      : {}),
  }
  const handle = serveStdio(() => createExplorationServer(serverOptions))
  const found = await load()
  options.log(`site-to-api MCP server on ${options.handoffDir}: ${typeof found === 'string'
    ? 'no handoff folder yet; tools will say how to make one'
    : `${found.operations.length} operations on ${found.hosts.length} host(s)`}${options.allowCalls
    ? `; call_operation on (${options.unsafeMethods
      ? 'writes allowed'
      : 'reads only'}, ${options.maxRps} request(s)/s)`
    : ''}`)
  return () => handle.close()
}

export { serveGenerated } from './generated'
