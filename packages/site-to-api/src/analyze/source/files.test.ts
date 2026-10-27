import { describe, expect, it } from 'vitest'
import { normalizeSourcePath, originalPathOf, sessionPath } from './files'

describe('normalizeSourcePath', () => {
  it('strips bundler schemes, project names, hosts and relative segments', () => {
    expect(normalizeSourcePath('webpack://shop/./src/api.ts')).toBe('src/api.ts')
    expect(normalizeSourcePath('webpack:///./src/api.ts')).toBe('src/api.ts')
    expect(normalizeSourcePath('webpack:///src/api.ts')).toBe('src/api.ts')
    expect(normalizeSourcePath('https://shop.test/assets/src/app.tsx?v=1')).toBe('assets/src/app.tsx')
    expect(normalizeSourcePath('../../src/x.js')).toBe('src/x.js')
    expect(normalizeSourcePath('webpack://shop/./node_modules/axios/index.js')).toBe('node_modules/axios/index.js')
  })

  it('maps unpacked files back to their original path', () => {
    expect(originalPathOf('sources/shop.test/src/api.ts', 'shop.test')).toBe('src/api.ts')
    expect(originalPathOf('elsewhere/src/api.ts', 'shop.test')).toBe('elsewhere/src/api.ts')
  })
})

describe('sessionPath', () => {
  const session = { dir: '/raw/s1' }

  it('keeps paths inside the session directory and rejects the rest', () => {
    expect(sessionPath(session, 'scripts/a.js')).toBe('/raw/s1/scripts/a.js')
    expect(sessionPath(session, '../s2/meta.json')).toBeNull()
    expect(sessionPath(session, '/etc/passwd')).toBeNull()
    expect(sessionPath(session, '')).toBeNull()
  })
})
