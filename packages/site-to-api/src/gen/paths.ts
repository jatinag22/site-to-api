/**
 * The folders generated text names (decision 0058). The client can live apart from the handoff
 * folder (`gen.clientDir`), so READMEs and messages print the real paths instead of a fixed
 * `client/`. All are relative with `/` separators, never absolute: the READMEs are committed.
 */
import path from 'node:path'

/** Paths generated READMEs and messages print. */
export interface GeneratedPaths {
  /** The client folder from the project root (`src/api/client`). */
  client: string
  /** The handoff folder from the project root (`api-handoff`). */
  handoff: string
  /** The handoff folder from the client folder (`..`). */
  handoffFromClient: string
  /** The MCP server folder from the project root (`api-handoff/mcp`). */
  mcp: string
  /** The client folder from the MCP folder, as an import prefix (`../client`). */
  clientFromMcp: string
}

/** The layout of a handoff folder `api-handoff` with the client in it, for callers that give none. */
export const DEFAULT_PATHS: GeneratedPaths = {
  client: 'api-handoff/client',
  handoff: 'api-handoff',
  handoffFromClient: '..',
  mcp: 'api-handoff/mcp',
  clientFromMcp: '../client',
}

/** A relative path with `/` separators; `.` for the same folder. */
export function posixPath(relative: string): string {
  return relative.split(path.sep).join('/') || '.'
}

/** The paths for a client in `clientDir` and a server in `mcpDir` built from `handoffDir`, seen from `root`. */
export function generatedPaths(root: string, handoffDir: string, clientDir: string, mcpDir: string = path.join(path.dirname(clientDir), 'mcp')): GeneratedPaths {
  return {
    client: posixPath(path.relative(root, clientDir)),
    handoff: posixPath(path.relative(root, handoffDir)),
    handoffFromClient: posixPath(path.relative(clientDir, handoffDir)),
    mcp: posixPath(path.relative(root, mcpDir)),
    clientFromMcp: dotted(posixPath(path.relative(mcpDir, clientDir))),
  }
}

/** `./dir` for a relative folder, so a shell command reads it as a path. */
export function dotted(relative: string): string {
  return relative.startsWith('.') || relative.startsWith('/')
    ? relative
    : `./${relative}`
}
