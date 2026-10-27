/**
 * Which URLs capture may fetch from Node on a page's behalf.
 *
 * Sourcemap URLs come from the site (a `SourceMap` header or a `sourceMappingURL` comment), and
 * Node's requests skip the browser's CORS and Private Network Access checks. Without a policy a
 * hostile page could make the machine running the capture request `localhost`, the LAN or a
 * cloud metadata service such as `169.254.169.254`.
 *
 * Rule ({@link sourceMapRefusal}): a map on a public host is fetched. A map on a non-public host
 * is fetched only when it is on the script's own origin and the page itself is on a non-public
 * host, which is the case for a development server or a local fixture site. Each redirect hop is
 * checked the same way.
 *
 * Known limitation: the name is resolved here and again by Playwright when it sends the request,
 * so a DNS server that answers differently the second time (DNS rebinding) is not stopped.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/** Resolves a host name to its IP addresses. Injected in tests so they need no DNS. */
export type Lookup = (hostname: string) => Promise<string[]>

async function systemLookup(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map(entry => entry.address)
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
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
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
 * The IPv4 address inside an IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) IPv6
 * address, which reach the embedded IPv4 host and so must be judged by it.
 */
function embeddedIpv4(address: string): string | null {
  const groups = ipv6Groups(address)
  if (groups === null)
    return null
  const mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xFFFF
  const nat64 = groups[0] === 0x64 && groups[1] === 0xFF9B && groups.slice(2, 6).every(group => group === 0)
  if (!mapped && !nat64)
    return null
  const high = groups[6] ?? 0
  const low = groups[7] ?? 0
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
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(host) !== 0) {
    return isPublicAddress(host)
      ? null
      : `${host} is a private, loopback or reserved address`
  }
  if (LOCAL_NAME.test(host) || !host.includes('.'))
    return `${host} is a local host name`
  let addresses: string[]
  try {
    addresses = await lookup(host)
  }
  catch {
    return `${host} could not be resolved`
  }
  if (addresses.length === 0)
    return `${host} could not be resolved`
  const inside = addresses.find(address => !isPublicAddress(address))
  return inside === undefined
    ? null
    : `${host} resolves to the non-public address ${inside}`
}

/**
 * Why capture must not fetch the sourcemap at `target` for a script at `scriptUrl`, or `null`
 * when it may. `pageIsLocal` says whether the page that loaded the script is itself on a
 * non-public host; see the rule at the top of this file.
 */
export async function sourceMapRefusal(target: URL, scriptUrl: URL, pageIsLocal: boolean, lookup: Lookup = systemLookup): Promise<string | null> {
  if (!/^https?:$/.test(target.protocol))
    return `${target.protocol} URLs are never fetched`
  const reason = await nonPublicReason(target.hostname, lookup)
  if (reason === null)
    return null
  if (target.origin !== scriptUrl.origin)
    return `${reason} and is not the script's own origin`
  return pageIsLocal
    ? null
    : `${reason} but the page is on a public host`
}
