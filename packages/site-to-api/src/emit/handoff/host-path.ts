/** Where each host's detail file lives in the handoff folder, and how `AGENT.md` links to it. */
import { code } from '../escape'
import { specFileName } from '../openapi/write'

/**
 * `hosts/<host>.md`, with the same file stem as the host's spec (`localhost:4173` →
 * `hosts/localhost_4173.md`). The stem holds only letters, digits, `_`, `.` and `-`, so it is safe
 * as a link target without escaping.
 */
export function hostDocPath(host: string): string {
  return `hosts/${specFileName(host).replace(/\.yaml$/, '')}.md`
}

/** A Markdown link to the host's file from `AGENT.md`, optionally to one of its sections. */
export function hostLink(host: string, section?: string): string {
  const path = hostDocPath(host)
  return `[${code(path)}](${path}${section === undefined
    ? ''
    : `#${section}`})`
}
