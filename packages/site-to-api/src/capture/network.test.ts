import type { Lookup } from './network'
import { describe, expect, it } from 'vitest'
import { isPublicAddress, nonPublicReason, sourceMapRefusal } from './network'

/** A fake resolver: no test touches real DNS. */
function fakeLookup(table: Record<string, string[]>): Lookup {
  return async (hostname) => {
    const found = table[hostname]
    if (found === undefined)
      throw new Error(`ENOTFOUND ${hostname}`)
    return found
  }
}

const lookup = fakeLookup({
  'cdn.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
  'example.com': ['93.184.216.34'],
  'rebind.example.com': ['93.184.216.34', '10.0.0.5'],
  'metadata.example.com': ['169.254.169.254'],
  'empty.example.com': [],
  'app.corp': ['10.1.0.10'],
  'static.corp': ['10.1.0.20'],
  'other.corp.example': ['10.2.0.1'],
  'static.corp.example': ['10.2.0.2'],
  'printer.lan.example': ['10.3.0.1'],
})

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local, CGNAT, documentation and multicast IPv4', () => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '192.0.2.1',
      '224.0.0.1',
      '255.255.255.255',
    ])
      expect(isPublicAddress(address), address).toBe(false)
  })

  it('accepts public IPv4', () => {
    for (const address of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
    ])
      expect(isPublicAddress(address), address).toBe(true)
  })

  it('refuses loopback, unique-local, link-local and multicast IPv6, and judges embedded IPv4 by itself', () => {
    for (const address of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::10.0.0.1',
      '2001:db8::1',
    ])
      expect(isPublicAddress(address), address).toBe(false)
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
    expect(isPublicAddress('::ffff:93.184.216.34')).toBe(true)
  })

  it('refuses IPv4-compatible and local-use NAT64 ranges, and judges IPv4-translated and 6to4 by their IPv4', () => {
    for (const address of [
      // Deprecated IPv4-compatible ::/96 is refused whole.
      '::7f00:1',
      '::127.0.0.1',
      '::8.8.8.8',
      // IPv4-translated ::ffff:0:0/96 (SIIT).
      '::ffff:0:127.0.0.1',
      '::ffff:0:a00:1',
      // 6to4 2002::/16 carries the IPv4 in bits 16-47.
      '2002:7f00:1::',
      '2002:a9fe:a9fe::1',
      '2002:c0a8:101::',
      // Local-use NAT64 64:ff9b:1::/48 (RFC 8215) is refused whole: where the IPv4 sits depends on
      // the operator's prefix length, so even a public-looking last 32 bits can hide 127.0.0.1.
      '64:ff9b:1::10.0.0.1',
      '64:ff9b:1::a9fe:a9fe',
      '64:ff9b:1:7f00:0:100::',
      '64:ff9b:1::93.184.216.34',
    ])
      expect(isPublicAddress(address), address).toBe(false)
    for (const address of [
      '::ffff:0:93.184.216.34',
      '2002:5db8:d822::1',
      '64:ff9b::93.184.216.34',
    ])
      expect(isPublicAddress(address), address).toBe(true)
  })

  it('refuses things that are not addresses', () => {
    expect(isPublicAddress('example.com')).toBe(false)
  })
})

describe('nonPublicReason', () => {
  it('accepts names whose every address is public', async () => {
    expect(await nonPublicReason('cdn.example.com', lookup)).toBeNull()
  })

  it('refuses a name when any of its addresses is not public', async () => {
    expect(await nonPublicReason('rebind.example.com', lookup)).toMatch(/10\.0\.0\.5/)
    expect(await nonPublicReason('metadata.example.com', lookup)).toMatch(/169\.254\.169\.254/)
  })

  it('refuses local names without resolving them', async () => {
    const never: Lookup = async () => {
      throw new Error('must not resolve')
    }
    for (const host of [
      'localhost',
      'api.localhost',
      'printer.local',
      'db.internal',
      'nas.home.arpa',
      'intranet',
    ])
      expect(await nonPublicReason(host, never), host).toMatch(/local host name/)
  })

  it('refuses IP literals, bracketed IPv6 included, without resolving them', async () => {
    expect(await nonPublicReason('127.0.0.1', lookup)).toMatch(/private, loopback/)
    expect(await nonPublicReason('[::1]', lookup)).toMatch(/private, loopback/)
    expect(await nonPublicReason('93.184.216.34', lookup)).toBeNull()
  })

  it('refuses names that do not resolve', async () => {
    expect(await nonPublicReason('missing.example.com', lookup)).toMatch(/could not be resolved/)
    expect(await nonPublicReason('empty.example.com', lookup)).toMatch(/could not be resolved/)
  })
})

describe('sourceMapRefusal', () => {
  const publicScript = new URL('https://example.com/static/app.js')
  const localScript = new URL('http://127.0.0.1:3000/static/app.js')
  const localPage = new URL('http://127.0.0.1:3000/')

  it('allows public maps, same-origin or not', async () => {
    expect(await sourceMapRefusal(new URL('https://example.com/static/app.js.map'), publicScript, null, lookup)).toBeNull()
    expect(await sourceMapRefusal(new URL('https://cdn.example.com/maps/app.js.map'), publicScript, null, lookup)).toBeNull()
  })

  it('refuses a public page pointing its map at a private host', async () => {
    for (const target of [
      'http://127.0.0.1:8080/x.map',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/x.map',
      'http://[::1]/x.map',
      'http://router.local/x.map',
      'https://metadata.example.com/x.map',
    ])
      expect(await sourceMapRefusal(new URL(target), publicScript, null, lookup), target).toMatch(/not the script's own origin/)
  })

  it('allows same-origin maps on a local page, as on a dev server', async () => {
    expect(await sourceMapRefusal(new URL('http://127.0.0.1:3000/static/app.js.map'), localScript, localPage, lookup)).toBeNull()
    expect(await sourceMapRefusal(new URL('http://localhost:5173/a.js.map'), new URL('http://localhost:5173/a.js'), new URL('http://localhost:5173/'), lookup)).toBeNull()
  })

  it('refuses another local origin even when the page is local', async () => {
    expect(await sourceMapRefusal(new URL('http://127.0.0.1:9999/x.map'), localScript, localPage, lookup)).toMatch(/not the script's own origin/)
    expect(await sourceMapRefusal(new URL('http://localhost:3000/static/app.js.map'), localScript, localPage, lookup)).toMatch(/not the script's own origin/)
  })

  it('refuses same-origin maps on a private host when the page is public', async () => {
    const internalScript = new URL('http://10.0.0.8/app.js')
    expect(await sourceMapRefusal(new URL('http://10.0.0.8/app.js.map'), internalScript, null, lookup)).toMatch(/page is on a public host/)
  })

  it('allows an intranet page to load maps from another private host of its own site', async () => {
    const intranetScript = new URL('http://app.corp/static/app.js')
    const intranetPage = new URL('http://app.corp/home')
    expect(await sourceMapRefusal(new URL('http://static.corp/maps/app.js.map'), intranetScript, intranetPage, lookup)).toBeNull()
    const nestedScript = new URL('http://other.corp.example/app.js')
    expect(await sourceMapRefusal(new URL('http://static.corp.example/app.js.map'), nestedScript, new URL('http://other.corp.example/'), lookup)).toBeNull()
  })

  it('refuses private hosts of another site, and never lets a public page reach the intranet', async () => {
    const intranetScript = new URL('http://app.corp/static/app.js')
    const intranetPage = new URL('http://app.corp/home')
    for (const target of [
      'http://printer.lan.example/x.map',
      'http://10.1.0.20/x.map',
      'http://127.0.0.1/x.map',
      'http://router.local/x.map',
      'http://localhost:9999/x.map',
    ])
      expect(await sourceMapRefusal(new URL(target), intranetScript, intranetPage, lookup), target).toMatch(/not the script's own origin/)
    // Shared local suffixes and loopback names never vouch for a neighbour.
    expect(await sourceMapRefusal(new URL('http://printer.local/x.map'), new URL('http://app.local/a.js'), new URL('http://app.local/'), lookup)).toMatch(/not the script's own origin/)
    expect(await sourceMapRefusal(new URL('http://api.dev.localhost/x.map'), new URL('http://web.dev.localhost/a.js'), new URL('http://web.dev.localhost/'), lookup)).toMatch(/not the script's own origin/)
    const cdnScript = new URL('https://cdn.example.com/app.js')
    expect(await sourceMapRefusal(new URL('http://static.corp/app.js.map'), cdnScript, null, lookup)).toMatch(/not the script's own origin/)
    expect(await sourceMapRefusal(new URL('http://static.corp/app.js.map'), new URL('http://app.corp/app.js'), null, lookup)).toMatch(/not the script's own origin/)
  })

  it('refuses non-HTTP URLs', async () => {
    expect(await sourceMapRefusal(new URL('file:///etc/passwd'), publicScript, localPage, lookup)).toMatch(/never fetched/)
  })
})
