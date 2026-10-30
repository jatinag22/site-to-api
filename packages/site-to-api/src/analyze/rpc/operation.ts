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

/**
 * Marks Connect operations whose method the site's code declares `NO_SIDE_EFFECTS` as reads, so
 * probe and the MCP servers may send them; other operations are returned unchanged.
 */
export function applyConnectIdempotency(operations: Operation[], levels: ReadonlyMap<string, Idempotency>): Operation[] {
  return operations.map((operation) => {
    const { rpc } = operation
    if (rpc?.protocol !== 'connect' || rpc.readOnly || levels.get(rpc.procedure) !== 'no-side-effects')
      return operation
    return {
      ...operation,
      rpc: { ...rpc, readOnly: true, readOnlyEvidence: 'NO_SIDE_EFFECTS in the site\'s descriptor' },
    }
  })
}
