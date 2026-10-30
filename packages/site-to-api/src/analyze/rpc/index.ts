/** tRPC and Connect RPC calls: marking, batch splitting, operations and idempotency (decision 0051). */
export { annotateRpc } from './annotate'
export { connectIdempotencyInText } from './descriptor'
export { applyConnectIdempotency, combineIdempotency, isRpcExchange, rpcGroupKey, rpcMethodReads, rpcOperationOf, rpcSummary } from './operation'
export type { DescribedFile } from './operation'
