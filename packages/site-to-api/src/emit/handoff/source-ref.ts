import type { SourceRef } from '../../model'

/** `file:line function` for a source reference, as plain text (callers escape it). */
export function describeSource(ref: SourceRef): string {
  return `${ref.file}:${ref.line}${ref.functionName
    ? ` ${ref.functionName}`
    : ''}`
}

/**
 * Said instead of a reference when the request came only from evaluated or anonymous code
 * (`Operation.sourceUnavailable`): `/5467:55 eval` would look like a location but lead nowhere.
 */
export const NO_SOURCE = 'no source available (eval or minified)'
