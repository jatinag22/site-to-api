import { describe, expect, it } from 'vitest'
import { registrableHost } from './registrable'

describe('registrableHost', () => {
  it('keeps the last two labels of ordinary hosts', () => {
    expect(registrableHost('www.example.com')).toBe('example.com')
    expect(registrableHost('a.b.api.Example.COM.')).toBe('example.com')
    expect(registrableHost('example.com')).toBe('example.com')
  })

  it('keeps three labels under country second-level suffixes', () => {
    expect(registrableHost('www.shop.co.uk')).toBe('shop.co.uk')
    expect(registrableHost('api.bank.com.au')).toBe('bank.com.au')
    expect(registrableHost('www.example.in')).toBe('example.in')
  })

  it('treats tenants of shared hosting suffixes as separate sites', () => {
    expect(registrableHost('alice.github.io')).toBe('alice.github.io')
    expect(registrableHost('docs.alice.github.io')).toBe('alice.github.io')
    expect(registrableHost('my-app.vercel.app')).toBe('my-app.vercel.app')
    // Cloud hosts whose tenants are different sites: one tenant's script vouches for no other.
    expect([
      'svc-a1b2-uc.a.run.app',
      'eu-west1-proj.cloudfunctions.net',
      'bucket-one.s3.amazonaws.com',
      'green-sea.azurestaticapps.net',
      'ab12.ngrok-free.app',
      'xyzproj.supabase.co',
    ].map(registrableHost)).toEqual([
      'svc-a1b2-uc.a.run.app',
      'eu-west1-proj.cloudfunctions.net',
      's3.amazonaws.com',
      'green-sea.azurestaticapps.net',
      'ab12.ngrok-free.app',
      'xyzproj.supabase.co',
    ])
  })

  it('returns IP addresses and single labels unchanged', () => {
    expect(registrableHost('127.0.0.1')).toBe('127.0.0.1')
    expect(registrableHost('[::1]')).toBe('[::1]')
    expect(registrableHost('localhost')).toBe('localhost')
  })
})
