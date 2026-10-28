/**
 * Which form field a computed value's input was typed into: a password the page encrypts before
 * sending never appears in any response, but the person's `change` on the field does.
 */
import type { CaptureEvent, TransformEvent, ValueTrace } from '../../model'

/** Transform input previews are cut at this length; a typed value is shorter. */
const INPUT_PREVIEW_LIMIT = 256

function normalizeField(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 0x20 || (code >= 0x7F && code <= 0x9F)
}

/**
 * Whether a transform input could be what the person typed: short enough not to be cut, and
 * text rather than bytes (a key or buffer preview holds control characters).
 */
export function looksTyped(preview: string): boolean {
  return preview.length > 0 && preview.length < INPUT_PREVIEW_LIMIT && ![...preview].some(isControlCharacter)
}

/** Input of {@link typedInputField}. */
export interface TypedInputQuery {
  /** A transform input no response produced. */
  preview: string
  event: TransformEvent
  /** Every event of the transform's session. */
  events: readonly CaptureEvent[]
  /** Traces of the request that sent the computed value. */
  requestTraces: readonly ValueTrace[]
  /** The computed value's request location, e.g. `body./password`. */
  inputKey: string
}

/**
 * The form field a transform input was typed into. Only fields changed on the same page before
 * the transform count. A field whose typed value the request also sends as-is is matched by that
 * value; otherwise the field named like the computed input wins (`password` for
 * `body./password`), then the latest other changed field. Values are never returned.
 */
export function typedInputField(query: TypedInputQuery): string | null {
  const { preview, event } = query
  const changed = query.events.flatMap(candidate =>
    candidate.t === 'action' && candidate.kind === 'change' && candidate.ts <= event.ts && candidate.pageUrl === event.pageUrl && candidate.field !== null
      ? [candidate.field]
      : [])
  if (changed.length === 0)
    return null
  const plain = query.requestTraces.flatMap(trace => trace.origin.kind === 'user-input'
    ? [
        { field: trace.origin.field, value: trace.value },
      ]
    : [])
  const sentAsIs = plain.find(item => item.value === preview && changed.includes(item.field))
  if (sentAsIs)
    return sentAsIs.field
  const others = changed.filter(field => !plain.some(item => item.field === field))
  const wanted = normalizeField(query.inputKey.split(/[./]/).at(-1) ?? '')
  return others.find(field => wanted !== '' && normalizeField(field) === wanted) ?? others.at(-1) ?? null
}
