/**
 * Writes OpenAPI documents as `specs/<host>.yaml`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'

/** Ports become `_<port>`: `:` is not allowed in Windows file names. */
function hostFileStem(host: string): string {
  return host.replace(/[^\w.-]/g, '_')
}

/** File name of a host's OpenAPI document under `specs/`. */
export function specFileName(host: string): string {
  return `${hostFileStem(host)}.yaml`
}

/** File name of a host's AsyncAPI document (WebSocket channels) under `specs/`. */
export function asyncApiFileName(host: string): string {
  return `${hostFileStem(host)}.asyncapi.yaml`
}

/** YAML text of one document: no line folding, no anchors, keys in insertion order. */
export function toYaml(document: object): string {
  return stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })
}

/**
 * Writes each document to `<outDir>/specs/<host>.yaml`.
 *
 * @returns the written file paths, sorted
 */
export async function writeOpenApiDocuments(outDir: string, documents: Map<string, object>): Promise<string[]> {
  const dir = join(outDir, 'specs')
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const host of [
    ...documents.keys(),
  ].sort()) {
    const document = documents.get(host)
    if (!document)
      continue
    const file = join(dir, specFileName(host))
    await writeFile(file, toYaml(document), 'utf8')
    written.push(file)
  }
  return written
}
