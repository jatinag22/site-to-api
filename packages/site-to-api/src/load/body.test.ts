import { Buffer } from 'node:buffer'
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeContentEncoding, MAX_DECODED_BODY_BYTES } from './body'

const TEXT = '{"context":{"client":{"clientName":"WEB"}},"query":"lofi"}'

describe('decodeContentEncoding', () => {
  it('decodes gzip, x-gzip, brotli and both kinds of deflate', () => {
    expect(decodeContentEncoding(gzipSync(TEXT), 'gzip')?.toString()).toBe(TEXT)
    expect(decodeContentEncoding(gzipSync(TEXT), 'X-GZIP')?.toString()).toBe(TEXT)
    expect(decodeContentEncoding(brotliCompressSync(TEXT), 'br')?.toString()).toBe(TEXT)
    expect(decodeContentEncoding(deflateSync(TEXT), 'deflate')?.toString()).toBe(TEXT)
    expect(decodeContentEncoding(deflateRawSync(TEXT), 'deflate')?.toString()).toBe(TEXT)
    expect(decodeContentEncoding(Buffer.from(TEXT), 'identity')?.toString()).toBe(TEXT)
  })

  it('undoes several codings in reverse order of application', () => {
    const twice = brotliCompressSync(gzipSync(TEXT))
    expect(decodeContentEncoding(twice, 'gzip, br')?.toString()).toBe(TEXT)
  })

  it('returns null for unknown codings and corrupt data', () => {
    expect(decodeContentEncoding(gzipSync(TEXT), 'compress')).toBeNull()
    expect(decodeContentEncoding(Buffer.from('not gzip'), 'gzip')).toBeNull()
  })

  it('refuses a body that expands past the limit (zip bomb)', () => {
    const bomb = gzipSync(Buffer.alloc(MAX_DECODED_BODY_BYTES + 1))
    expect(bomb.length).toBeLessThan(64 * 1024)
    expect(decodeContentEncoding(bomb, 'gzip')).toBeNull()
  })
})
