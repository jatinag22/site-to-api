/**
 * Which source locations get an excerpt in the handoff folder.
 */
import type { Analysis, SourceRef } from '../model'

/**
 * Every source location the handoff folder points at, except those in bot-protection scripts: an
 * excerpt of a vendor's challenge or sensor code is the logic decision 0008 never reproduces, and
 * such scripts embed the tokens they mint (a Kasada `ips.js` held its own session cookie value).
 * Their references keep the file and line, without an excerpt.
 */
export function referencedSources(analysis: Analysis): SourceRef[] {
  const vendorFiles = new Set([
    ...analysis.operations.filter(operation => operation.kind === 'bot-protection').flatMap(operation => operation.sentFrom),
    ...analysis.flows.flows.flatMap(flow => flow.steps.filter(step => step.browserOnly).map(step => step.sentFrom)),
  ].flatMap(ref => ref === null
    ? []
    : [ref.file]))
  return collectReferences(analysis).filter(ref => !vendorFiles.has(ref.file))
}

function collectReferences(analysis: Analysis): SourceRef[] {
  const refs: SourceRef[] = analysis.operations.flatMap(operation => operation.sentFrom)
  for (const channel of analysis.channels ?? []) {
    if (channel.sentFrom)
      refs.push(channel.sentFrom)
  }
  for (const flow of analysis.flows.flows) {
    for (const step of flow.steps) {
      if (step.sentFrom)
        refs.push(step.sentFrom)
    }
  }
  for (const value of analysis.flows.computedValues) {
    if (value.producedBy)
      refs.push(value.producedBy)
    if (value.calledFrom)
      refs.push(value.calledFrom)
  }
  return refs
}
