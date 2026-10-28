import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { requestValidationInput } from './request-validation'

describe('requestValidationInput', () => {
  it('turns a Headers instance into a plain object a Zod object schema can read', async () => {
    const schema = z.object({
      body: z.object({
        username: z.string(),
      }),
      headers: z.object({
        'x-csrf-token': z.string(),
      }),
    })
    const options = {
      body: { username: 'demo' },
      headers: new Headers({ 'X-CSRF-Token': 'abc', 'Content-Type': 'application/json' }),
      url: '/api/auth/login',
    }
    // The bug this guards against: a Headers instance has no own properties.
    await expect(schema.parseAsync(options)).rejects.toThrow()
    const input = requestValidationInput(options)
    expect(input).toEqual({
      body: { username: 'demo' },
      headers: { 'x-csrf-token': 'abc', 'content-type': 'application/json' },
      url: '/api/auth/login',
    })
    await expect(schema.parseAsync(input)).resolves.toEqual({
      body: { username: 'demo' },
      headers: { 'x-csrf-token': 'abc' },
    })
  })

  it('also keeps the exact spelling of the header names it is given', () => {
    const input = requestValidationInput({
      headers: new Headers({ 'x-api-version': '2' }),
    }, ['X-Api-Version', 'X-Absent'])
    expect(input).toEqual({
      headers: { 'x-api-version': '2', 'X-Api-Version': '2' },
    })
  })

  it('returns anything else unchanged', () => {
    const plain = {
      headers: { a: '1' },
    }
    expect(requestValidationInput(plain)).toBe(plain)
    expect(requestValidationInput(undefined)).toBeUndefined()
    expect(requestValidationInput('text')).toBe('text')
    const noHeaders = { body: 1 }
    expect(requestValidationInput(noHeaders)).toBe(noHeaders)
  })
})
