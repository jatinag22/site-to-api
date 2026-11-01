import { describe, expect, it } from 'vitest'
import { failureMessage } from './failure'

describe('failureMessage', () => {
  it('drops colour codes and Playwright\'s call log', () => {
    const error = new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4999/\nCall log:\n\u001B[2m  - navigating to "http://localhost:4999/", waiting until "load"\u001B[22m\n')
    expect(failureMessage(error)).toBe('page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4999/')
  })

  it('keeps a plain message and reads non-errors', () => {
    expect(failureMessage(new Error('boom'))).toBe('boom')
    expect(failureMessage('\u001B[31mred\u001B[39m text')).toBe('red text')
  })
})
