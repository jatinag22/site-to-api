/**
 * Makes inferred extraction specs behave identically in generated clients. Inference verifies a
 * spec with its own implementation; generated clients run `extract()` from the runtime. Any field
 * the two read differently (they coerce dates and numbers with separate rules) is downgraded to a
 * string, and dropped if they still disagree.
 */
import type { ExtractSpec } from '@site-to-api/runtime'
import { extract } from '@site-to-api/runtime'
import { applyExtractSpec } from '../analyze/html'

type Records = Array<Record<string, unknown>>

function asRecords(value: ReturnType<typeof extract>): Records {
  return Array.isArray(value)
    ? value
    : [value]
}

function normalise(value: unknown): unknown {
  return value === undefined
    ? null
    : value
}

function fieldsThatDisagree(spec: ExtractSpec, samples: string[]): Set<string> {
  const disagree = new Set<string>()
  for (const sample of samples) {
    const expected: Records = applyExtractSpec(sample, spec)
    let actual: Records
    try {
      actual = asRecords(extract(sample, spec))
    }
    catch {
      return new Set(Object.keys(spec.fields))
    }
    if (actual.length !== expected.length)
      return new Set(Object.keys(spec.fields))
    for (const name of Object.keys(spec.fields)) {
      if (expected.some((record, index) => normalise(record[name]) !== normalise(actual[index]?.[name])))
        disagree.add(name)
    }
  }
  return disagree
}

function withFields(spec: ExtractSpec, change: (name: string) => 'keep' | 'string' | 'drop'): ExtractSpec {
  const copy = structuredClone(spec)
  for (const name of Object.keys(copy.fields)) {
    const decision = change(name)
    if (decision === 'drop')
      Reflect.deleteProperty(copy.fields, name)
    else if (decision === 'string')
      copy.fields[name]!.type = 'string'
  }
  return copy
}

/** Returns a spec the runtime reads exactly like inference did, or `null` if no field survives. */
export function alignWithRuntime(spec: ExtractSpec, samples: string[]): ExtractSpec | null {
  const first = fieldsThatDisagree(spec, samples)
  if (first.size === 0)
    return spec
  const downgraded = withFields(spec, name => first.has(name)
    ? 'string'
    : 'keep')
  const second = fieldsThatDisagree(downgraded, samples)
  const aligned = withFields(downgraded, name => second.has(name)
    ? 'drop'
    : 'keep')
  return Object.keys(aligned.fields).length > 0
    ? aligned
    : null
}
