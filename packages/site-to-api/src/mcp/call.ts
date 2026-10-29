/**
 * `call_operation` (decision 0043): sends one request through the generated client in
 * `<handoff>/client/` and `@site-to-api/runtime`, under the rules `probe` follows (decision
 * 0012): safe methods only unless `--unsafe-methods`, rate limited, never a bot-protection step.
 * Credentials come only from environment variables the person sets; nothing is read from the raw
 * captures.
 */
import type { OperationEntry } from './catalog'
import type { Handoff, HandoffHost } from './handoff'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { join } from 'pathe'
import { z } from 'zod'
import { sdkFunctionName } from '../emit/naming'
import { SiteToApiError } from '../errors'
import { RateLimiter } from '../probe/rate-limit'
import { untrustedReason } from '../trust'

/** Prefix of the environment variables `call_operation` reads credentials from. */
const CREDENTIAL_ENV_PREFIX = 'SITE_API_'

/** Options for {@link createCaller}. */
export interface CallerOptions {
  handoff: Handoff
  maxRps: number
  timeoutMs: number
  /** Where credentials are read from; `process.env` in the CLI. */
  env: Record<string, string | undefined>
  /**
   * `--trust-client`: run `client/` even when this machine did not generate it (decision 0043).
   * Off by default: the client is code from the folder, and a cloned repository controls it.
   */
  trustClient?: boolean
  /** Trust store to check against; defaults to the person's config directory. */
  trustStore?: string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The SDK options the agent passed: what `get_operation` shows as the client call. */
export interface CallArguments {
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
  headers?: Record<string, string>
  variables?: unknown
}

/** What a call returned. */
export interface CallOutcome {
  status: number | null
  ok: boolean
  contentType: string | null
  /** The validated response body (parsed JSON, or text). */
  data?: unknown
  error?: unknown
  /** Set when the text was cut to the size limit. */
  truncated?: boolean
}

/** Longest response text a tool result carries; more would crowd the agent's context. */
const MAX_TEXT = 50_000

const ClientModuleSchema = z.object({
  createSiteClient: z.custom<(options: unknown) => unknown>(value => typeof value === 'function'),
  CookieJar: z.custom<new () => unknown>(value => typeof value === 'function'),
})

const SiteClientSchema = z.object({
  sdk: z.record(z.string(), z.unknown()),
})

const JarSchema = z.object({
  setCookieString: z.custom<(url: string, header: string) => boolean>(value => typeof value === 'function'),
})

const ResultSchema = z.object({
  data: z.unknown().optional(),
  error: z.unknown().optional(),
  response: z.instanceof(Response).optional(),
})

/**
 * The environment variable names that hold a host's credentials: the per-host one
 * (`SITE_API_COOKIE_SHOP_EXAMPLE_COM`) first, and the plain one only when the folder has one
 * host, so a cookie meant for one site is never sent to another.
 */
export function credentialNames(host: HandoffHost, hostCount: number, kind: 'COOKIE' | 'AUTH'): string[] {
  const own = `${CREDENTIAL_ENV_PREFIX}${kind}_${host.identifier.toUpperCase()}`
  return hostCount === 1
    ? [own, `${CREDENTIAL_ENV_PREFIX}${kind}`]
    : [own]
}

function credential(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value !== '')
      return value
  }
  return undefined
}

/** `a=1; b=2` → `['a=1', 'b=2']`, ignoring empty parts. */
export function cookiePairs(header: string): string[] {
  return header.split(';').map(part => part.trim()).filter(part => part.includes('=') && !part.startsWith('='))
}

/** Errors serialize to `{}`; keep their message (and the network cause, e.g. ECONNREFUSED). */
function describeError(value: unknown): unknown {
  if (!(value instanceof Error))
    return value
  const inner = value.cause
  const code = typeof inner === 'object' && inner !== null && 'code' in inner && typeof inner.code === 'string'
    ? inner.code
    : ''
  const cause = inner instanceof Error
    ? `: ${inner.message || code || inner.name}`
    : ''
  return `${value.name}: ${value.message}${cause}`
}

function limitText(value: unknown): { value: unknown, truncated: boolean } {
  if (typeof value === 'string' && value.length > MAX_TEXT)
    return { value: `${value.slice(0, MAX_TEXT)}…`, truncated: true }
  if (typeof value !== 'string' && value !== undefined) {
    const text = JSON.stringify(value)
    if (text !== undefined && text.length > MAX_TEXT)
      return { value: `${text.slice(0, MAX_TEXT)}…`, truncated: true }
  }
  return { value, truncated: false }
}

/** Generated code imports these; they resolve to the copies this tool runs with. */
function runtimeAliases(): Record<string, string> {
  return {
    '@site-to-api/runtime': fileURLToPath(import.meta.resolve('@site-to-api/runtime')),
    'zod': fileURLToPath(import.meta.resolve('zod')),
  }
}

/**
 * A function that sends one operation through the generated client. The client module is loaded
 * on the first call, so a server that never calls does not compile it.
 */
export function createCaller(options: CallerOptions): (entry: OperationEntry, args: CallArguments) => Promise<CallOutcome> {
  const limiter = new RateLimiter(1000 / options.maxRps, options.now ?? Date.now, options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))
  const baseFetch = options.fetch ?? globalThis.fetch
  // Every request the runtime sends, redirects included, waits its turn and has a deadline.
  // Every request the runtime sends, redirects included, waits its turn, has a deadline and stays
  // on the host's origin: a redirect elsewhere is refused before anything is sent there.
  const limitedFetch = (origin: string): typeof fetch => async (input, init) => {
    const url = input instanceof Request
      ? input.url
      : String(input)
    const target = URL.parse(url)
    if (target === null || target.origin !== origin)
      throw new SiteToApiError(`refused to follow a redirect to another origin (${target?.origin ?? 'an unparsable URL'}); nothing was sent there`)
    await limiter.wait()
    return baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(options.timeoutMs) })
  }
  let loaded: Promise<z.infer<typeof ClientModuleSchema>> | null = null
  const clients = new Map<string, Record<string, unknown>>()

  async function loadClient(): Promise<z.infer<typeof ClientModuleSchema>> {
    const path = join(options.handoff.dir, 'client', 'index.ts')
    // The client is code, and the folder may come from anyone: run it only when this machine
    // generated it, or the person said they reviewed it.
    if (options.trustClient !== true) {
      const reason = await untrustedReason(join(options.handoff.dir, 'client'), options.trustStore)
      if (reason !== null)
        throw new SiteToApiError(reason)
    }
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: runtimeAliases(),
    })
    let module: unknown
    try {
      module = await jiti.import(path)
    }
    catch (error) {
      throw new SiteToApiError(`Could not load the generated client ${path}: ${error instanceof Error
        ? error.message
        : String(error)}. Run \`site-to-api gen\` to regenerate it.`, { cause: error })
    }
    const parsed = ClientModuleSchema.safeParse(module)
    if (!parsed.success)
      throw new SiteToApiError(`${path} does not export createSiteClient; run \`site-to-api gen\` to regenerate it.`)
    return parsed.data
  }

  async function sdkFor(host: HandoffHost): Promise<Record<string, unknown>> {
    const existing = clients.get(host.host)
    if (existing !== undefined)
      return existing
    loaded ??= loadClient()
    const module = await loaded
    const jar = new module.CookieJar()
    const cookies = credential(options.env, credentialNames(host, options.handoff.hosts.length, 'COOKIE'))
    if (cookies !== undefined) {
      const parsedJar = JarSchema.parse(jar)
      for (const pair of cookiePairs(cookies))
        parsedJar.setCookieString.call(jar, host.baseUrl, pair)
    }
    const auth = credential(options.env, credentialNames(host, options.handoff.hosts.length, 'AUTH'))
    const client = SiteClientSchema.parse(module.createSiteClient({
      host: host.host,
      jar,
      fetch: limitedFetch(new URL(host.baseUrl).origin),
      // One request per call: retries would send more than the agent asked for.
      retry: false,
      ...(auth === undefined
        ? {}
        : { auth }),
    }))
    clients.set(host.host, client.sdk)
    return client.sdk
  }

  return async (entry, args) => {
    const host = options.handoff.hosts.find(candidate => candidate.host === entry.host)
    if (host === undefined)
      throw new SiteToApiError(`Host ${entry.host} has no spec in this handoff folder.`)
    const sdk = await sdkFor(host)
    const name = sdkFunctionName(entry.operationId)
    const fn = sdk[name]
    if (typeof fn !== 'function')
      throw new SiteToApiError(`The generated client has no function ${name} for ${entry.operationId}; run \`site-to-api gen\` to regenerate it.`)
    const returned: unknown = await Reflect.apply(fn, sdk, [args])
    const result = ResultSchema.parse(returned)
    const response = result.response
    const data = limitText(result.data)
    const error = limitText(describeError(result.error))
    return {
      status: response?.status ?? null,
      ok: response?.ok === true && result.error === undefined,
      contentType: response?.headers.get('content-type') ?? null,
      ...(result.data === undefined
        ? {}
        : { data: data.value }),
      ...(result.error === undefined
        ? {}
        : { error: error.value }),
      ...(data.truncated || error.truncated
        ? { truncated: true }
        : {}),
    }
  }
}
