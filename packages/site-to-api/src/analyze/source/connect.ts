/**
 * Reads the site's code for Connect RPC method idempotency (decision 0050). The matching is pure
 * (`analyze/rpc`); this only reads the files.
 */
import type { LoadedSession } from '../../model'
import type { Idempotency } from '../rpc'
import { connectIdempotencyInText } from '../rpc'
import { readSessionFile, siteCodeFiles } from './files'

/**
 * Idempotency of every Connect method the site's code describes, keyed `package.Service/Method`.
 * Files shared by sessions are read once per distinct content; files are read in a fixed order.
 */
export async function findConnectIdempotency(sessions: LoadedSession[]): Promise<Map<string, Idempotency>> {
  const result = new Map<string, Idempotency>()
  const scanned = new Map<string, string>()
  for (const session of sessions) {
    for (const file of siteCodeFiles(session)) {
      const key = `${file.kind}:${file.host}:${file.path}`
      const text = await readSessionFile(session, file.file)
      if (text === null || scanned.get(key) === text)
        continue
      scanned.set(key, text)
      for (const [method, level] of connectIdempotencyInText(text)) {
        if (!result.has(method))
          result.set(method, level)
      }
    }
  }
  return result
}
