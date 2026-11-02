/**
 * Makes inferred extraction specs behave identically in generated clients. Inference verifies a
 * spec with its own implementation; generated clients run `extract()` from the runtime. Any field
 * the two read differently (they coerce dates and numbers with separate rules) is downgraded to a
 * string, and dropped if they still disagree.
 */
import type { ExtractSpec } from 'site-to-api-runtime'
import { extract } from 'site-to-api-runtime'
import { applyExtractSpec } from '../analyze/html'

type Records = Array<Record<string, unknown>>

function asRecords(value: ReturnType<typeof extract>): Records {
  return Array.isArray(value)
    ? value
    : [value]
}

/**
 * Inference reads an empty element as `null` and the runtime reads it as `""`. Both mean the
 * element shows nothing, which a nullable string field allows either way, so they count as the
 * same: otherwise a field one sample leaves empty (a profile with no `about`) is dropped.
 */
function normalise(value: unknown): unknown {
  return value === undefined || value === ''
    ? null
    : value
}

interface Disagreement {
  fields: Set<string>
  /** Set when the runtime rejected the spec outright (an invalid selector, for example). */
  error: string | null
}

function fieldsThatDisagree(spec: ExtractSpec, samples: string[]): Disagreement {
  const all = new Set(Object.keys(spec.fields))
  const disagree = new Set<string>()
  for (const sample of samples) {
    let expected: Records
    let actual: Records
    try {
      expected = applyExtractSpec(sample, spec)
      actual = asRecords(extract(sample, spec))
    }
    catch (error) {
      return {
        fields: all,
        error: error instanceof Error
          ? error.message
          : String(error),
      }
    }
    if (actual.length !== expected.length)
      return { fields: all, error: null }
    for (const name of Object.keys(spec.fields)) {
      // Own keys only: a field named `constructor` must not read the inherited function.
      const read = (record: Record<string, unknown> | undefined): unknown => record !== undefined && Object.hasOwn(record, name)
        ? record[name]
        : undefined
      if (expected.some((record, index) => normalise(read(record)) !== normalise(read(actual[index]))))
        disagree.add(name)
    }
  }
  return { fields: disagree, error: null }
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

export interface AlignedSpec {
  spec: ExtractSpec | null
  /** Why the runtime rejected the spec, for a build warning; `null` when it did not. */
  error: string | null
}

/** Returns a spec the runtime reads exactly like inference did (`null` if no field survives). */
export function alignWithRuntime(spec: ExtractSpec, samples: string[]): AlignedSpec {
  const first = fieldsThatDisagree(spec, samples)
  if (first.error !== null)
    return { spec: null, error: first.error }
  if (first.fields.size === 0)
    return { spec, error: null }
  const downgraded = withFields(spec, name => first.fields.has(name)
    ? 'string'
    : 'keep')
  const second = fieldsThatDisagree(downgraded, samples)
  if (second.error !== null)
    return { spec: null, error: second.error }
  const aligned = withFields(downgraded, name => second.fields.has(name)
    ? 'drop'
    : 'keep')
  return {
    spec: Object.keys(aligned.fields).length > 0
      ? aligned
      : null,
    error: null,
  }
}
