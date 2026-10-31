/**
 * Stage 8 (`html`): locates values inside HTML and text responses and infers extraction specs
 * that turn those responses into records.
 */
export { applyExtractSpec } from './apply'
export { inferExtraction } from './infer'
export { createHtmlLocator } from './locate'
export { holdsLearntWord } from './pattern'
