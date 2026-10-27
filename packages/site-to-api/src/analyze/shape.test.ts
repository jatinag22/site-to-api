import { describe, expect, it } from 'vitest'
import { describeShape, inspectJwt } from './shape'

function jwt(header: object, payload: object): string {
  const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '')
  return `${encode(header)}.${encode(payload)}.signature`
}

describe('inspectJwt', () => {
  it('returns the algorithm and sorted claim names', () => {
    expect(inspectJwt(jwt({ alg: 'RS256', typ: 'JWT' }, { sub: '1', exp: 2 }))).toEqual({
      alg: 'RS256',
      claims: ['exp', 'sub'],
    })
  })

  it('rejects values that only look like three segments', () => {
    expect(inspectJwt('a.b.c')).toBeNull()
    expect(inspectJwt('example.com.au')).toBeNull()
  })
})

describe('describeShape', () => {
  it('never contains the value itself', () => {
    const secret = 'f3a9c2d14b7e8a90f3a9c2d14b7e8a90'
    const shape = describeShape(secret)
    expect(shape).toBe('32 hex chars')
    expect(shape).not.toContain(secret)
  })

  it('recognises common formats', () => {
    expect(describeShape('123e4567-e89b-42d3-a456-426614174000')).toBe('UUID')
    expect(describeShape('0042')).toBe('4-digit number')
    expect(describeShape('YWJjZGVmZ2hpamtsbW5vcA==')).toBe('24 base64 chars')
    expect(describeShape(jwt({ alg: 'HS256' }, { scope: 'x' }))).toBe('JWT (alg=HS256, claims=[scope])')
  })

  it('lists separators for structured tokens', () => {
    expect(describeShape('ab~cd~ef;gh')).toBe('11 chars, separators ";~"')
  })
})
