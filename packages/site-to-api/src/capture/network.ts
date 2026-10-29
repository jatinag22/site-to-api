/**
 * Which URLs capture may fetch from Node on a page's behalf.
 *
 * Sourcemap URLs come from the site (a `SourceMap` header or a `sourceMappingURL` comment), and
 * Node's requests skip the browser's CORS and Private Network Access checks. Without a policy a
 * hostile page could make the machine running the capture request `localhost`, the LAN or a
 * cloud metadata service such as `169.254.169.254`.
 *
 * Rule ({@link sourceMapRefusal}): a map on a public host is fetched. A map on a non-public host
 * is fetched only when the page itself is on a non-public host (a development server, a local
 * fixture site, an intranet app) and the map is on the script's own origin or on a host of the
 * page's own site ({@link intranetSite}: `app.corp` and `static.corp`). A public page never
 * reaches a non-public address. Each redirect hop is checked the same way.
 *
 * Known limitation: the name is resolved here and again by Playwright when it sends the request,
 * so a DNS server that answers differently the second time (DNS rebinding) is not stopped.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { registrableHost } from './frames'

/** Resolves a host name to its IP addresses. Injected in tests so they need no DNS. */
export type Lookup = (hostname: string) => Promise<string[]>

async function systemLookup(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map(entry => entry.address)
}

/** Lookups tried per host before it counts as unresolvable: one failure under load is common. */
const LOOKUP_ATTEMPTS = 2

/**
 * A lookup that asks once per host and retries a failure. A page loads dozens of scripts from one
 * host at once; a lookup per script floods the resolver, and one that times out made a host the
 * browser had just loaded from look unresolvable.
 */
export function cachedLookup(lookup: Lookup = systemLookup): Lookup {
  const cache = new Map<string, Promise<string[]>>()
  const attempt = async (hostname: string, left: number): Promise<string[]> => {
    try {
      return await lookup(hostname)
    }
    catch (error) {
      if (left <= 1)
        throw error
      return await attempt(hostname, left - 1)
    }
  }
  return async (hostname) => {
    const key = hostname.toLowerCase()
    let pending = cache.get(key)
    if (!pending) {
      pending = attempt(hostname, LOOKUP_ATTEMPTS)
      cache.set(key, pending)
    }
    return await pending
  }
}

/** Addresses that are not on the public internet (IANA special-purpose registries). */
const NON_PUBLIC = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  // Unspecified, loopback and the deprecated IPv4-compatible block (RFC 4291 section 2.5.5.1).
  ['::', 96],
  ['100::', 64],
  // Local-use NAT64 (RFC 8215). The embedded IPv4 sits at a position set by the operator's
  // prefix length (RFC 6052 section 2.2), so it cannot be read reliably; the block is never
  // global anyway.
  ['64:ff9b:1::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6')

/** Names that only resolve inside a machine or network (RFC 6761, 6762, 8375 and `.internal`). */
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal|home\.arpa|lan|intranet)$/i

/** Expands an IPv6 address into its eight 16-bit groups, or `null` when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  const groups: number[] = []
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number)
    text = `${text.slice(0, v4.index)}${(((a ?? 0) << 8) | (b ?? 0)).toString(16)}:${(((c ?? 0) << 8) | (d ?? 0)).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const parse = (part: string): number[] => part === ''
    ? []
    : part.split(':').map(group => Number.parseInt(group, 16))
  const front = parse(head)
  const back = tail === undefined
    ? []
    : parse(tail)
  const missing = 8 - front.length - back.length
  if (tail === undefined
    ? missing !== 0
    : missing < 0) {
    return null
  }
  groups.push(...front, ...Array.from<number>({ length: missing }).fill(0), ...back)
  return groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xFFFF)
    ? groups
    : null
}

/**
 * The IPv4 address an IPv6 address reaches, which it must be judged by: IPv4-mapped
 * (`::ffff:a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`, RFC 2765) and well-known NAT64
 * (`64:ff9b::a.b.c.d`) carry it in the last 32 bits, 6to4 (`2002:aabb:ccdd::`, RFC 3056) in bits
 * 16 to 47.
 */
function embeddedIpv4(address: string): string | null {
  const groups = ipv6Groups(address)
  if (groups === null)
    return null
  const zero = (from: number, to: number): boolean => groups.slice(from, to).every(group => group === 0)
  const mapped = zero(0, 5) && groups[5] === 0xFFFF
  const translated = zero(0, 4) && groups[4] === 0xFFFF && groups[5] === 0
  const nat64 = groups[0] === 0x64 && groups[1] === 0xFF9B && zero(2, 6)
  let high: number
  let low: number
  if (mapped || translated || nat64) {
    high = groups[6] ?? 0
    low = groups[7] ?? 0
  }
  else if (groups[0] === 0x2002) {
    high = groups[1] ?? 0
    low = groups[2] ?? 0
  }
  else {
    return null
  }
  return [
    high >> 8,
    high & 0xFF,
    low >> 8,
    low & 0xFF,
  ].join('.')
}

/** True for an IP address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4)
    return !NON_PUBLIC.check(address, 'ipv4')
  if (version !== 6)
    return false
  const inner = embeddedIpv4(address)
  if (inner !== null)
    return isPublicAddress(inner)
  return !NON_PUBLIC.check(address, 'ipv6')
}

/**
 * Why a host is not public, or `null` when it is: local-only names and single-label names are
 * refused without a lookup; other names are public only when every address they resolve to is.
 */
export async function nonPublicReason(hostname: string, lookup: Lookup = systemLookup): Promise<string | null> {
  const status = await hostStatus(hostname, lookup)
  return status.kind === 'public'
    ? null
    : status.reason
}

type HostStatus = { kind: 'public' } | { kind: 'non-public' | 'unresolved', reason: string }

async function hostStatus(hostname: string, lookup: Lookup): Promise<HostStatus> {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(host) !== 0) {
    return isPublicAddress(host)
      ? { kind: 'public' }
      : { kind: 'non-public', reason: `${host} is a private, loopback or reserved address` }
  }
  if (LOCAL_NAME.test(host) || !host.includes('.'))
    return { kind: 'non-public', reason: `${host} is a local host name` }
  let addresses: string[] = []
  try {
    addresses = await lookup(host)
  }
  catch {
    // Handled below like an empty answer.
  }
  if (addresses.length === 0)
    return { kind: 'unresolved', reason: `${host} could not be resolved from Node (the browser may use its own DNS or a proxy; capture again if this was a passing DNS failure)` }
  const inside = addresses.find(address => !isPublicAddress(address))
  return inside === undefined
    ? { kind: 'public' }
    : { kind: 'non-public', reason: `${host} resolves to the non-public address ${inside}` }
}

/**
 * The page URL when the page is on a non-public host, which earns it the intranet allowances of
 * {@link sourceMapRefusal}; otherwise null. A page whose host does not resolve is not known to be
 * private, so it counts as public: the safe side (decision 0019).
 */
export async function localPageOf(pageUrl: string | null, lookup: Lookup = systemLookup): Promise<URL | null> {
  if (pageUrl === null)
    return null
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  }
  catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol))
    return null
  return (await hostStatus(parsed.hostname, lookup)).kind === 'non-public'
    ? parsed
    : null
}

/**
 * The site a non-public host name belongs to, for letting an intranet page reach its own other
 * hosts, or `null` when the name never vouches for another host: IP addresses (`10.0.0.5` says
 * nothing about `10.0.0.6`), single labels and `localhost` names, which reach this machine.
 * Otherwise it is the {@link registrableHost}, except that a host of two labels such as
 * `app.corp` belongs to its last label (`corp`), since a private top-level name has no public
 * suffix to keep.
 * Shared local suffixes (`.local`, `.lan`, `.internal`) do not collapse: `printer.local` is not
 * part of `app.local`.
 */
function intranetSite(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || !host.includes('.') || /(?:^|\.)localhost$/.test(host))
    return null
  const registrable = registrableHost(host)
  const labels = registrable.split('.')
  // Only a host that is itself two labels (`app.corp`) collapses to its last label: for
  // `int.evil.example` that would make every `*.example` host the same site.
  return labels.length === 2 && host === registrable && !LOCAL_NAME.test(registrable)
    ? labels[1] ?? registrable
    : registrable
}

/**
 * Why capture must not fetch the sourcemap at `target` for a script at `scriptUrl`, or `null`
 * when it may. `localPage` is the URL of the page that loaded the script when that page is itself
 * on a non-public host, and `null` when it is public or unknown; see the rule at the top of this
 * file.
 */
export async function sourceMapRefusal(target: URL, scriptUrl: URL, localPage: URL | null, lookup: Lookup = systemLookup): Promise<string | null> {
  if (!/^https?:$/.test(target.protocol))
    return `${target.protocol} URLs are never fetched`
  const status = await hostStatus(target.hostname, lookup)
  if (status.kind === 'public')
    return null
  // Not knowing the address is not knowing it is private: say only that.
  if (status.kind === 'unresolved')
    return status.reason
  const { reason } = status
  const ownOrigin = target.origin === scriptUrl.origin
  if (localPage === null) {
    return ownOrigin
      ? `${reason} but the page is on a public host`
      : `${reason} and is not the script's own origin`
  }
  const site = intranetSite(target.hostname)
  if (ownOrigin || (site !== null && site === intranetSite(localPage.hostname)))
    return null
  return `${reason} and is not the script's own origin or a host of the page's own site`
}
