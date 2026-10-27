import { describe, expect, it } from 'vitest'
import { parseV8Stack } from './stack'

describe('parseV8Stack', () => {
  it('parses named, anonymous, async and constructor frames', () => {
    const stack = [
      'Error',
      '    at login (https://example.com/app.js:10:5)',
      '    at https://example.com/app.js:20:7',
      '    at async submit (https://example.com/app.js:30:9)',
      '    at new Client (https://example.com/vendor.js:1:200)',
      '    at Object.<anonymous> (https://example.com/a.js:2:3)',
    ].join('\n')
    expect(parseV8Stack(stack)).toEqual([
      {
        url: 'https://example.com/app.js',
        line: 10,
        column: 5,
        functionName: 'login',
      },
      {
        url: 'https://example.com/app.js',
        line: 20,
        column: 7,
        functionName: null,
      },
      {
        url: 'https://example.com/app.js',
        line: 30,
        column: 9,
        functionName: 'submit',
      },
      {
        url: 'https://example.com/vendor.js',
        line: 1,
        column: 200,
        functionName: 'new Client',
      },
      {
        url: 'https://example.com/a.js',
        line: 2,
        column: 3,
        functionName: 'Object.<anonymous>',
      },
    ])
  })

  it('drops frames from the instrumentation script and native frames', () => {
    const stack = [
      'Error',
      '    at stack (site-to-api-instrument.js:40:12)',
      '    at window.fetch (site-to-api-instrument.js:90:3)',
      '    at Array.forEach (<anonymous>)',
      '    at load (http://127.0.0.1:3000/app.js:3:1)',
    ].join('\n')
    expect(parseV8Stack(stack)).toEqual([
      {
        url: 'http://127.0.0.1:3000/app.js',
        line: 3,
        column: 1,
        functionName: 'load',
      },
    ])
  })

  it('uses the call site of eval frames', () => {
    const stack = '    at eval (eval at run (https://example.com/a.js:5:6), <anonymous>:1:1)'
    expect(parseV8Stack(stack)).toEqual([
      {
        url: 'https://example.com/a.js',
        line: 5,
        column: 6,
        functionName: 'eval',
      },
    ])
  })

  it('keeps ports in URLs and ignores garbage', () => {
    expect(parseV8Stack('at f (http://localhost:8080/x.js:1:2)\nnot a frame\n    at ')).toEqual([
      {
        url: 'http://localhost:8080/x.js',
        line: 1,
        column: 2,
        functionName: 'f',
      },
    ])
    expect(parseV8Stack('')).toEqual([])
  })
})
