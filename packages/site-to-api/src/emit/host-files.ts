/**
 * File-name stems for hosts: `specs/<stem>.yaml`, `specs/<stem>.asyncapi.yaml` and
 * `hosts/<stem>.md` all use the same stem, from one map built over every host of the build.
 * Host names come from the captured site, so the stem keeps only letters, digits, `_`, `.` and
 * `-`; `:` (a port) is not allowed in Windows file names.
 */
import { createHash } from 'node:crypto'

/** Host → file-name stem, built by {@link hostStems}. */
export type HostStems = ReadonlyMap<string, string>

/** `localhost:4173` → `localhost_4173`. */
function sanitize(host: string): string {
  return host.replace(/[^\w.-]/g, '_')
}

/** First `length` hex characters of the host's SHA-256: the same for the same host in any build. */
function suffix(host: string, length: number): string {
  return createHash('sha256').update(host).digest('hex').slice(0, length)
}

/**
 * The stem of every host. Two hosts whose sanitized names are equal, ignoring case because
 * macOS and Windows file systems do (`a.com:1` and `a.com_1`, `[::1]:80` and `_::1_:80`), would
 * write the same file; each of them except a host already spelled like the stem gets `-<hash>`,
 * eight hex characters of its SHA-256, lengthened in the unlikely case that is taken too. Stems
 * of hosts without a clash are their sanitized names, so ordinary output is unchanged.
 * Deterministic: the result depends only on the set of hosts.
 */
export function hostStems(hosts: Iterable<string>): HostStems {
  const sorted = [
    ...new Set(hosts),
  ].sort()
  const groups = new Map<string, string[]>()
  for (const host of sorted) {
    const key = sanitize(host).toLowerCase()
    groups.set(key, [
      ...(groups.get(key) ?? []),
      host,
    ])
  }
  const taken = new Set(groups.keys())
  const stems = new Map<string, string>()
  for (const group of groups.values()) {
    // The host spelled exactly like its stem keeps it; without one, the first in sort order does.
    const keeper = group.find(host => sanitize(host) === host) ?? group[0]
    for (const host of group) {
      if (host === keeper) {
        stems.set(host, sanitize(host))
        continue
      }
      let length = 8
      let stem = `${sanitize(host)}-${suffix(host, length)}`
      while (taken.has(stem.toLowerCase()) && length < 64) {
        length += 4
        stem = `${sanitize(host)}-${suffix(host, length)}`
      }
      taken.add(stem.toLowerCase())
      stems.set(host, stem)
    }
  }
  return stems
}

/** The host's stem; a host missing from the map (never one the build saw) uses its sanitized name. */
export function hostStem(stems: HostStems, host: string): string {
  return stems.get(host) ?? sanitize(host)
}
