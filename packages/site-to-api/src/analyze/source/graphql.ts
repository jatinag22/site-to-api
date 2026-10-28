/**
 * Reads the site's code for the types of GraphQL operations the capture did not show
 * (decision 0027). The matching itself is pure (`analyze/graphql`); this only reads the files.
 */
import type { GraphqlOperationType, LoadedSession } from '../../model'
import type { GraphqlTypeTarget } from '../graphql'
import { graphqlTypesInText } from '../graphql'
import { readSessionFile, siteCodeFiles } from './files'

/**
 * Every type each target's code states, across the site's code files of every session, keyed by
 * target key. Files shared by sessions are read once per distinct content.
 */
export async function findGraphqlTypes(sessions: LoadedSession[], targets: readonly GraphqlTypeTarget[]): Promise<Map<string, Array<Exclude<GraphqlOperationType, 'unknown'>>>> {
  const result = new Map<string, Array<Exclude<GraphqlOperationType, 'unknown'>>>()
  if (targets.length === 0)
    return result
  const scanned = new Map<string, string>()
  for (const session of sessions) {
    for (const file of siteCodeFiles(session)) {
      const key = `${file.kind}:${file.host}:${file.path}`
      const text = await readSessionFile(session, file.file)
      if (text === null || scanned.get(key) === text)
        continue
      scanned.set(key, text)
      for (const [target, types] of graphqlTypesInText(text, targets)) {
        result.set(target, [
          ...(result.get(target) ?? []),
          ...types,
        ])
      }
    }
  }
  return result
}
