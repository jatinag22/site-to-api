/**
 * Writes OpenAPI documents as `specs/<host>.yaml`.
 */
import type { HostStems } from '../host-files'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { hostStem } from '../host-files'

/** File name of a host's OpenAPI document under `specs/`, with the stem from `stems`. */
export function specFileName(host: string, stems: HostStems): string {
  return `${hostStem(stems, host)}.yaml`
}

/** File name of a host's AsyncAPI document (WebSocket channels) under `specs/`. */
export function asyncApiFileName(host: string, stems: HostStems): string {
  return `${hostStem(stems, host)}.asyncapi.yaml`
}

/** YAML text of one document: no line folding, no anchors, keys in insertion order. */
export function toYaml(document: object): string {
  return stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })
}

/**
 * Writes each document to `<outDir>/specs/<stem>.yaml`, the stem from `stems` (see `hostStems`).
 *
 * @returns the written file paths, sorted
 */
export async function writeOpenApiDocuments(outDir: string, documents: Map<string, object>, stems: HostStems): Promise<string[]> {
  const dir = join(outDir, 'specs')
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const host of [
    ...documents.keys(),
  ].sort()) {
    const document = documents.get(host)
    if (!document)
      continue
    const file = join(dir, specFileName(host, stems))
    await writeFile(file, toYaml(document), 'utf8')
    written.push(file)
  }
  return written
}
