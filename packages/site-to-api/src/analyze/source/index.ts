export { findSourceEndpoints } from './endpoints'
/**
 * Stage 7 (`source`): maps stack frames to the site's original code, finds endpoints mentioned in
 * that code, collects its string constants and cuts excerpts for the handoff folder.
 */
export { buildExcerpt } from './excerpt'
export { createSourceResolver } from './resolver'
export type { LoadedSourceResolver } from './resolver'
export { collectStaticStrings, MAX_STATIC_STRINGS } from './strings'
