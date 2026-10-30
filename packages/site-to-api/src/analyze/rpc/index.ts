/** tRPC and Connect RPC calls: marking, batch splitting, operations and idempotency (decision 0050). */
export { annotateRpc } from './annotate'
export { connectIdempotencyInText } from './descriptor'
export type { Idempotency } from './descriptor'
export { applyConnectIdempotency, isRpcExchange, rpcGroupKey, rpcOperationOf, rpcSummary } from './operation'
