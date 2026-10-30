/**
 * Reads the site's code for Connect RPC method idempotency (decision 0051). The matching is pure
 * (`analyze/rpc`); this only reads the files.
 */
import type { LoadedSession } from '../../model'
import type { DescribedFile } from '../rpc'
import { registrableHost } from '../../hosts'
import { connectIdempotencyInText } from '../rpc'
import { readSessionFile, siteCodeFiles } from './files'

/**
 * The Connect method idempotency each code file describes, with the site (registrable domain)
 * that served it, for {@link combineIdempotency}. Files shared by sessions are read once per
 * distinct content; files are read in a fixed order.
 */
export async function findConnectIdempotency(sessions: LoadedSession[]): Promise<DescribedFile[]> {
  const result: DescribedFile[] = []
  const scanned = new Map<string, string>()
  for (const session of sessions) {
    for (const file of siteCodeFiles(session)) {
      const key = `${file.kind}:${file.host}:${file.path}`
      const text = await readSessionFile(session, file.file)
      if (text === null || scanned.get(key) === text)
        continue
      scanned.set(key, text)
      const levels = connectIdempotencyInText(text)
      if (levels.size > 0) {
        result.push({
          site: registrableHost(file.host.replace(/:\d+$/, '')),
          levels,
        })
      }
    }
  }
  return result
}
