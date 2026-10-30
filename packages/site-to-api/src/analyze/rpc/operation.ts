/**
 * What an RPC operation is (decision 0050): its protocol, procedure and whether it only reads.
 */
import type { Exchange, Operation, RpcOperation, RpcRequest } from '../../model'
import type { Idempotency } from './descriptor'

/** An exchange marked as a tRPC or Connect call. */
export type RpcExchange = Exchange & { rpc: RpcRequest }

export function isRpcExchange(exchange: Exchange): exchange is RpcExchange {
  return exchange.rpc !== undefined
}

/** Calls that share a host, method, endpoint and procedure are one operation. */
export function rpcGroupKey(exchange: RpcExchange): string {
  return `${exchange.request.host} ${exchange.request.method} ${exchange.request.path} ${exchange.rpc.protocol} ${exchange.rpc.procedure}`
}

/**
 * The operation facts of a group of calls to one procedure. A GET says it only reads: tRPC sends
 * queries with GET and mutations with POST, and Connect sends a call with GET only for methods
 * marked `NO_SIDE_EFFECTS`.
 */
export function rpcOperationOf(group: readonly RpcExchange[]): RpcOperation | null {
  const [first] = group
  if (first === undefined)
    return null
  const get = group.every(exchange => exchange.request.method === 'GET')
  return {
    protocol: first.rpc.protocol,
    procedure: first.rpc.procedure,
    readOnly: get,
    readOnlyEvidence: get
      ? 'called with GET'
      : null,
  }
}

/** `Connect RPC method buf.registry.module.v1.ModuleService/GetModules.` and the like. */
export function rpcSummary(rpc: RpcOperation, method: string): string {
  if (rpc.protocol === 'connect')
    return `Connect RPC method ${rpc.procedure}.`
  return `tRPC ${method === 'GET'
    ? 'query'
    : 'mutation'} ${rpc.procedure}.`
}

/** The descriptors one code file holds, and the site (registrable domain) that served it. */
export interface DescribedFile {
  site: string
  levels: ReadonlyMap<string, Idempotency>
}

/**
 * Per site, the methods its own code files describe. A method two files describe differently
 * is left out: which one the page used is not known, and a wrong `NO_SIDE_EFFECTS` would let
 * probe send a write.
 */
export function combineIdempotency(files: readonly DescribedFile[]): Map<string, Map<string, Idempotency>> {
  const result = new Map<string, Map<string, Idempotency>>()
  const conflicts = new Set<string>()
  for (const file of files) {
    const site = result.get(file.site) ?? new Map<string, Idempotency>()
    result.set(file.site, site)
    for (const [method, level] of file.levels) {
      const key = `${file.site} ${method}`
      const known = site.get(method)
      if (conflicts.has(key))
        continue
      if (known !== undefined && known !== level) {
        conflicts.add(key)
        site.delete(method)
        continue
      }
      site.set(method, level)
    }
  }
  return result
}

/**
 * Words in a method name that say it writes (`CreateOrder`, `TransferFunds`, `SendInvite`).
 * Such a method is never a safe read, whatever a descriptor claims.
 */
const WRITE_WORDS: ReadonlySet<string> = new Set([
  'add',
  'apply',
  'approve',
  'archive',
  'assign',
  'buy',
  'cancel',
  'charge',
  'checkout',
  'claim',
  'clear',
  'close',
  'commit',
  'confirm',
  'create',
  'delete',
  'disable',
  'edit',
  'enable',
  'grant',
  'insert',
  'invite',
  'join',
  'leave',
  'login',
  'logout',
  'merge',
  'modify',
  'move',
  'order',
  'patch',
  'pay',
  'post',
  'publish',
  'purchase',
  'put',
  'refund',
  'register',
  'reject',
  'remove',
  'rename',
  'replace',
  'reset',
  'restore',
  'revoke',
  'save',
  'send',
  'set',
  'submit',
  'subscribe',
  'transfer',
  'unsubscribe',
  'update',
  'upload',
  'upsert',
  'verify',
  'vote',
  'withdraw',
  'write',
])

/** Lower-case words of the method part of a procedure: `pkg.Service/BatchGetUsers` → `[batch, get, users]`. */
function methodWords(procedure: string): string[] {
  return procedure
    .slice(procedure.lastIndexOf('/') + 1)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word !== '')
}

/**
 * Verbs a read starts with. A list of reads, not of writes: writes have too many names
 * (`Payout`, `BookFlight`, `ToggleFeature`, `Mint`) for a list of them to be complete.
 */
const READ_VERBS: ReadonlySet<string> = new Set([
  'browse',
  'check',
  'count',
  'describe',
  'estimate',
  'exists',
  'fetch',
  'find',
  'get',
  'has',
  'list',
  'load',
  'lookup',
  'preview',
  'query',
  'read',
  'resolve',
  'retrieve',
  'scan',
  'search',
  'show',
  'stream',
  'view',
  'watch',
])

/** Whether the method part of a procedure names a write (`pkg.Service/TransferFunds`). */
function rpcMethodWrites(procedure: string): boolean {
  return methodWords(procedure).some(word => WRITE_WORDS.has(word))
}

/**
 * Whether a method's name says it only reads: its first word is a read verb (after `batch`, as
 * in `BatchGetUsers`; `Look Up` counts as `lookup`) and no word names a write
 * (`GetOrCreateUser`). A descriptor's `NO_SIDE_EFFECTS` counts only for such a method.
 */
export function rpcMethodReads(procedure: string): boolean {
  const words = methodWords(procedure)
  const verbs = words[0] === 'batch'
    ? words.slice(1)
    : words
  const first = verbs[0] === 'look' && verbs[1] === 'up'
    ? 'lookup'
    : verbs[0]
  return first !== undefined && READ_VERBS.has(first) && !rpcMethodWrites(procedure)
}

/**
 * Marks Connect operations whose method the site's own code declares `NO_SIDE_EFFECTS` as reads,
 * so probe may send them. Only descriptors served by the operation's own site count (a third
 * party's script must not vouch for a site's method), and only a method whose name says it
 * reads ({@link rpcMethodReads}) is marked. Other operations are returned unchanged.
 */
export function applyConnectIdempotency(operations: Operation[], bySite: ReadonlyMap<string, ReadonlyMap<string, Idempotency>>, siteOf: (host: string) => string): Operation[] {
  return operations.map((operation) => {
    const { rpc } = operation
    if (rpc?.protocol !== 'connect' || rpc.readOnly || !rpcMethodReads(rpc.procedure))
      return operation
    if (bySite.get(siteOf(operation.host))?.get(rpc.procedure) !== 'no-side-effects')
      return operation
    return {
      ...operation,
      rpc: { ...rpc, readOnly: true, readOnlyEvidence: 'NO_SIDE_EFFECTS in the site\'s descriptor' },
    }
  })
}
