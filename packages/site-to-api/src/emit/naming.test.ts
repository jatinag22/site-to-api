import { describe, expect, it } from 'vitest'
import { responseSchemaName, sdkFunctionName } from './naming'

describe('naming', () => {
  it('matches the names hey-api 0.99 generates', () => {
    // Checked against real hey-api output, including its re-casing of mixed-case ids.
    expect(sdkFunctionName('getApiItems')).toBe('getApiItems')
    expect(responseSchemaName('getApiItems')).toBe('zGetApiItemsResponse')
    expect(sdkFunctionName('postWwwnseindiacomM2KPU8LSs')).toBe('postWwwnseindiacomM2Kpu8Lss')
    expect(responseSchemaName('get_api-items')).toBe('zGetApiItemsResponse')
  })
})
