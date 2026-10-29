/**
 * Which generated clients this machine trusts to run (decision 0043). `call_operation` and the
 * generated MCP server execute the code in `client/`; a cloned repository can commit any code
 * there. `gen` records a content hash of each client it writes in a store in the person's own
 * config directory, outside every project, so a repository cannot commit a matching entry. A
 * client whose files no longer hash to the recorded value is not run.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { dirname, join, relative } from 'pathe'
import { z } from 'zod'
import { SiteToApiError } from '../errors'

const StoreSchema = z.object({
  formatVersion: z.literal(1),
  /** Real path of a `client/` folder → SHA-256 of its files. */
  clients: z.record(z.string(), z.object({
    sha256: z.string(),
  })),
})
type Store = z.infer<typeof StoreSchema>

/** The message for a client this machine did not generate (or that changed since). */
export const UNTRUSTED_CLIENT = 'this client wasn\'t generated on this machine; run `site-to-api gen` to regenerate it, or pass `--trust-client` if you reviewed it'

/**
 * `$XDG_CONFIG_HOME/site-to-api/trusted-clients.json`, or `~/.config/...` without it. Outside
 * every project on purpose: a project's own folders, gitignored or not, are what a repository
 * controls.
 */
export function trustStorePath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
    ? env.XDG_CONFIG_HOME
    : join(os.homedir(), '.config')
  return join(base, 'site-to-api', 'trusted-clients.json')
}

/** SHA-256 over every file of `clientDir`: sorted relative paths and contents, so any change shows. */
export async function clientHash(clientDir: string): Promise<string> {
  const entries = await readdir(clientDir, { recursive: true, withFileTypes: true })
  const files = entries
    .filter(entry => !entry.isDirectory())
    .map(entry => relative(clientDir, join(entry.parentPath, entry.name)))
    .sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file}\0`)
    // A symbolic link is hashed by what it points to now, so retargeting it changes the hash.
    hash.update(await readFile(join(clientDir, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function readStore(path: string): Promise<Store> {
  if (!existsSync(path))
    return { formatVersion: 1, clients: {} }
  const invalid = (cause?: unknown): SiteToApiError =>
    new SiteToApiError(`${path} is not a site-to-api trust store. Delete it; the next \`site-to-api gen\` writes it again.`, { cause })
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw invalid(error)
  }
  const parsed = StoreSchema.safeParse(raw)
  if (!parsed.success)
    throw invalid()
  return parsed.data
}

/** Records the client in `clientDir` as generated here. Called by `gen` (and `build`) after writing it. */
export async function trustClient(clientDir: string, storePath: string = trustStorePath()): Promise<void> {
  const store = await readStore(storePath)
  const key = await realpath(clientDir)
  store.clients[key] = { sha256: await clientHash(clientDir) }
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 })
  const temporary = `${storePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, storePath)
}

/** Null when `clientDir` is a client this machine generated and nobody changed since; otherwise why not. */
export async function untrustedReason(clientDir: string, storePath: string = trustStorePath()): Promise<string | null> {
  if (!existsSync(clientDir))
    return null
  const recorded = (await readStore(storePath)).clients[await realpath(clientDir)]
  if (recorded === undefined || recorded.sha256 !== await clientHash(clientDir))
    return `${clientDir}: ${UNTRUSTED_CLIENT}`
  return null
}
