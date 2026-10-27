/**
 * Most sites send every request through one helper (`apiFetch`, `request`, an axios instance).
 * Pointing every "sent from" at that helper tells an agent nothing, so a call site shared by
 * several operations is treated as a wrapper and the next frame up, the code with intent (the
 * login handler, the product loader), is reported instead.
 */
import type { Exchange, SourceRef, SourceResolver, StackFrame } from '../../model'

function key(ref: SourceRef): string {
  return `${ref.file}:${ref.line}`
}

export interface WrapperAwareOptions {
  /** Distinct operations a call site must serve before it counts as a wrapper. */
  threshold?: number
}

/**
 * Wraps a resolver so `callSite` skips request wrappers. `operationOf` maps an exchange to its
 * operationId (or `null` when it has none).
 */
export function createWrapperAwareResolver(
  base: SourceResolver,
  exchanges: Exchange[],
  operationOf: (exchange: Exchange) => string | null,
  options: WrapperAwareOptions = {},
): SourceResolver & { wrappers: ReadonlySet<string> } {
  const threshold = options.threshold ?? 3
  const wrappers = new Set<string>()

  const callSite = (stack: StackFrame[], sessionId: string): SourceRef | null => {
    const first = base.callSite(stack, sessionId)
    let current = first
    let frames = stack
    // A few levels at most: a wrapper may call a second, inner wrapper.
    for (let depth = 0; depth < 4 && current && wrappers.has(key(current)); depth++) {
      const site = key(current)
      const index = frames.findIndex(frame => key(base.resolve(frame, sessionId)) === site)
      if (index === -1)
        break
      frames = frames.slice(index + 1)
      const next = base.callSite(frames, sessionId)
      if (!next)
        break
      current = next
    }
    return current ?? first
  }

  // Wrappers are found in rounds: skipping `apiFetch` exposes `getJson`, which may be a second
  // shared layer that only becomes visible once the first is skipped.
  for (let round = 0; round < 4; round++) {
    const operationsBySite = new Map<string, Set<string>>()
    for (const exchange of exchanges) {
      const operationId = operationOf(exchange)
      if (!operationId || !exchange.initiator || exchange.initiator.stack.length === 0)
        continue
      const ref = callSite(exchange.initiator.stack, exchange.sessionId)
      if (!ref)
        continue
      const set = operationsBySite.get(key(ref)) ?? new Set<string>()
      set.add(operationId)
      operationsBySite.set(key(ref), set)
    }
    const found = [...operationsBySite].filter(([site, ops]) => ops.size >= threshold && !wrappers.has(site))
    if (found.length === 0)
      break
    for (const [site] of found)
      wrappers.add(site)
  }

  return { resolve: base.resolve, callSite, wrappers }
}
