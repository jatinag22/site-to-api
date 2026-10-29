/**
 * Stage 8 (`html`): infers how to turn an operation's HTML or text responses into records, and
 * verifies the result by running it over every sample.
 */
import type { ExtractSpec } from '@site-to-api/runtime'
import type { Draft } from './records'
import type { TextDraft } from './text'
import type { ExtractedValue } from './values'
import { applyExtractSpec } from './apply'
import { inferDetail } from './detail'
import { allElements, looksLikeHtml, parseHtml, select } from './dom'
import { inferRecords, recordElements } from './records'
import { inferText } from './text'

/** What `inferExtraction` returns: the spec, how many samples it was inferred from, and how sure it is. */
interface InferredExtraction {
  spec: ExtractSpec
  samples: number
  confidence: 'high' | 'low'
}

function isHtmlSample(sample: { text: string, mimeType: string }): boolean {
  return /html|xml/i.test(sample.mimeType) || looksLikeHtml(sample.text)
}

function isJson(text: string): boolean {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed))
    return false
  try {
    JSON.parse(trimmed)
    return true
  }
  catch {
    return false
  }
}

function fieldCount(draft: { spec: ExtractSpec } | null): number {
  return draft
    ? Object.keys(draft.spec.fields).length
    : 0
}

/** Chooses between a record list and a detail layout found in the same samples. */
function chooseHtml(texts: string[]): Draft | null {
  const documents = texts.map(parseHtml)
  const several = documents.length >= 2
  const records = inferRecords(documents, several)
  // Positions inside the records vary too; they belong to the records, not to a detail layout.
  const [first] = documents
  const inRecords = new Set(records && first
    ? recordElements(records, first).flatMap(record => [
        record,
        ...allElements(record),
      ])
    : [])
  const detail = inferDetail(documents, several, inRecords)
  // A lone sample needs two label/value pairs before it counts as a detail page.
  const usableDetail = detail && (several || fieldCount(detail) >= 2)
    ? detail
    : null
  if (!records || !usableDetail)
    return records ?? usableDetail
  // A real list (three or more records a page) outweighs positions that merely differ between
  // pages; only labelled values (`Price: …`) still make the page a detail page.
  const perSample = first
    ? select(records.spec.records, first).length
    : 0
  const rival = perSample >= 3
    ? fieldCount(inferDetail(documents, false, inRecords))
    : fieldCount(usableDetail)
  return fieldCount(records) * 2 >= rival
    ? records
    : usableDetail
}

/**
 * Re-extracts every sample with the spec and keeps only fields whose values match what inference
 * expected; a record count that differs means the record selector is wrong and the spec is
 * dropped. Returns the verified spec, or `null` when nothing survives.
 */
function verify(draft: Draft | TextDraft, texts: string[]): { spec: ExtractSpec, consistent: boolean } | null {
  const perSample = texts.map(text => applyExtractSpec(text, draft.spec))
  const records = perSample.flat()
  const expectedLength = Object.values(draft.expected)[0]?.length ?? 0
  if (records.length !== expectedLength || records.length === 0)
    return null
  const kept = Object.keys(draft.spec.fields).filter((name) => {
    const expected: Array<ExtractedValue | null> = draft.expected[name] ?? []
    return records.every((record, index) => record[name] === expected[index])
  })
  if (kept.length === 0)
    return null
  const spec = structuredClone(draft.spec)
  for (const name of Object.keys(spec.fields)) {
    if (!kept.includes(name))
      Reflect.deleteProperty(spec.fields, name)
  }
  const single = draft.spec.kind === 'html' && !draft.spec.many
  const consistent = perSample.every(sampleRecords => single
    ? sampleRecords.length === 1
    : sampleRecords.length > 0)
  && records.every(record => kept.some(name => record[name] !== null))
  return { spec, consistent }
}

/**
 * Infers an extraction spec from responses of one operation.
 *
 * HTML samples are compared to separate template from data: repeated records (table rows,
 * repeated sibling structures) give `many: true`, a single item gives `:root` with
 * `many: false`. Field names come from headers and labels, types from the values, with patterns
 * that strip currency symbols, units and labels. Text samples give delimited (CSV, TSV, pipe,
 * semicolon) or `key: value` pattern specs.
 *
 * With one sample only tables, definition lists and label/value pairs are used and confidence is
 * `low`. Confidence is `high` once there are at least `minSamples` samples and the verified spec
 * extracts records from every one of them. Returns `null` for JSON, free-form prose, mixed
 * HTML/text samples, or when no spec survives verification.
 */
export function inferExtraction(
  samples: Array<{ text: string, mimeType: string }>,
  options: { minSamples: number },
): InferredExtraction | null {
  const texts = samples.map(sample => sample.text)
  if (texts.length === 0 || texts.some(isJson))
    return null
  const html = samples.filter(isHtmlSample).length
  if (html !== 0 && html !== samples.length)
    return null
  const draft = html > 0
    ? chooseHtml(texts)
    : inferText(texts)
  const verified = draft
    ? verify(draft, texts)
    : null
  if (!verified)
    return null
  const high = samples.length >= 2 && samples.length >= options.minSamples && verified.consistent
  return {
    spec: verified.spec,
    samples: samples.length,
    confidence: high ? 'high' : 'low',
  }
}
