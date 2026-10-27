/** Writes `flows.json`, `flows.schema.json` and `flows.md` into the handoff folder. */
import type { FlowsDocument, Operation } from '../../model'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { SiteToApiError } from '../../errors'
import { FlowsDocumentSchema } from '../../model'
import { renderFlowsMarkdown } from './markdown'

export { renderFlowsMarkdown, responseSchemaName } from './markdown'

/** Value of `$schema` in `flows.json`: the schema file written next to it. */
const SCHEMA_FILE = 'flows.schema.json'

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Validates `doc` against {@link FlowsDocumentSchema} and writes `flows.json`,
 * `flows.schema.json` and `flows.md` to `outDir`. Returns the written paths. Throws
 * {@link SiteToApiError} without writing anything when the document is invalid, because an
 * invalid file would mislead every consumer that trusts the published schema.
 */
export async function writeFlows(outDir: string, doc: FlowsDocument, context: { operations: Operation[] }): Promise<string[]> {
  const parsed = FlowsDocumentSchema.safeParse({ ...doc, $schema: doc.$schema ?? `./${SCHEMA_FILE}` })
  if (!parsed.success)
    throw new SiteToApiError(`flows.json failed validation, so nothing was written. This is a bug in site-to-api; please report it with this message:\n${z.prettifyError(parsed.error)}`)
  const files: Array<[string, string]> = [
    [
      'flows.json',
      stableJson(parsed.data),
    ],
    [
      SCHEMA_FILE,
      stableJson(z.toJSONSchema(FlowsDocumentSchema)),
    ],
    [
      'flows.md',
      renderFlowsMarkdown(parsed.data, context.operations),
    ],
  ]
  await mkdir(outDir, { recursive: true })
  const written: string[] = []
  for (const [name, content] of files) {
    const path = join(outDir, name)
    await writeFile(path, content, 'utf8')
    written.push(path)
  }
  return written
}
