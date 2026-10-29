/**
 * Writes AsyncAPI documents as `specs/<host>.asyncapi.yaml`, beside the host's OpenAPI document.
 */
import type { HostStems } from '../host-files'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'pathe'
import { asyncApiFileName, specFileName, toYaml } from '../openapi'

/** What {@link writeAsyncApiDocuments} wrote and skipped. */
export interface WrittenAsyncApi {
  /** Written file paths, sorted by host. */
  files: string[]
  warnings: string[]
}

/**
 * Writes each document to `<outDir>/specs/<host>.asyncapi.yaml`. A document whose file name is
 * taken by an OpenAPI spec (a host literally named `x.asyncapi`) is skipped with a warning
 * rather than overwriting the spec.
 *
 * @param outDir the handoff folder
 * @param documents AsyncAPI documents by host
 * @param openApiHosts hosts that have an OpenAPI document in the same folder
 * @param stems the file-name stem of every host of the build (see `hostStems`)
 */
export async function writeAsyncApiDocuments(outDir: string, documents: Map<string, object>, openApiHosts: readonly string[], stems: HostStems): Promise<WrittenAsyncApi> {
  const dir = join(outDir, 'specs')
  const taken = new Set(openApiHosts.map(host => specFileName(host, stems)))
  const files: string[] = []
  const warnings: string[] = []
  for (const host of [
    ...documents.keys(),
  ].sort()) {
    const document = documents.get(host)
    if (!document)
      continue
    const name = asyncApiFileName(host, stems)
    if (taken.has(name)) {
      warnings.push(`The WebSocket channels of ${host} were not written: specs/${name} is the OpenAPI spec of another host.`)
      continue
    }
    await mkdir(dir, { recursive: true })
    const file = join(dir, name)
    await writeFile(file, toYaml(document), 'utf8')
    files.push(file)
  }
  return { files, warnings }
}
