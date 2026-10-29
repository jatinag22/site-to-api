/** Where each host's detail file lives in the handoff folder, and how `AGENT.md` links to it. */
import type { Analysis, SessionRequirement } from '../../model'
import type { HostStems } from '../host-files'
import { code } from '../escape'
import { hostStem, hostStems } from '../host-files'

/** Renders a link to a host's file, optionally to one of its sections (`gaps`). */
export type HostLinker = (host: string, section?: string) => string

/**
 * Every host the handoff folder names in a file name: hosts with operations or channels, with a
 * session verdict, or that served only pages. `build` builds the stems for `specs/` from the same
 * set, so a host's spec and its `hosts/` file always share a stem.
 */
function handoffHosts(analysis: Analysis, pageHosts: readonly SessionRequirement[] = []): string[] {
  return [
    ...new Set([
      ...analysis.hosts,
      ...analysis.operations.map(operation => operation.host),
      ...(analysis.channels ?? []).map(channel => channel.host),
      ...analysis.flows.session.map(entry => entry.host),
      ...pageHosts.map(entry => entry.host),
    ]),
  ].sort()
}

/** The stems of {@link handoffHosts}. */
export function handoffStems(analysis: Analysis, pageHosts: readonly SessionRequirement[] = []): HostStems {
  return hostStems(handoffHosts(analysis, pageHosts))
}

/**
 * `hosts/<stem>.md`, with the same stem as the host's spec (`localhost:4173` →
 * `hosts/localhost_4173.md`). The stem holds only letters, digits, `_`, `.` and `-`, so it is safe
 * as a link target without escaping.
 */
export function hostDocPath(host: string, stems: HostStems): string {
  return `hosts/${hostStem(stems, host)}.md`
}

/** Links from `AGENT.md` to host files, with the stems of this build. */
export function hostLinker(stems: HostStems): HostLinker {
  return (host, section) => {
    const path = hostDocPath(host, stems)
    return `[${code(path)}](${path}${section === undefined
      ? ''
      : `#${section}`})`
  }
}
