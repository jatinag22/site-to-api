import type { SourceRef } from '../../model'

/** `file:line function` for a source reference, as plain text (callers escape it). */
export function describeSource(ref: SourceRef): string {
  return `${ref.file}:${ref.line}${ref.functionName
    ? ` ${ref.functionName}`
    : ''}`
}
