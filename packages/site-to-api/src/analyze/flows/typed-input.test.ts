import type { CaptureEvent, TransformEvent, ValueTrace } from '../../model'
import { describe, expect, it } from 'vitest'
import { looksTyped, typedInputField } from './typed-input'

const page = 'https://shop.test/login'

function change(field: string, ts: number, pageUrl = page): CaptureEvent {
  return {
    t: 'action',
    ts,
    pageUrl,
    kind: 'change',
    label: field,
    selector: `#${field}`,
    field,
  }
}

const transform: TransformEvent = {
  t: 'transform',
  ts: 10,
  pageUrl: page,
  api: 'crypto.subtle.encrypt',
  output: ['x'],
  inputs: [],
  details: null,
  stack: [],
}

function plain(field: string, value: string): ValueTrace {
  return {
    exchangeId: 'e1',
    location: { in: 'body', pointer: `/${field}` },
    value,
    origin: { kind: 'user-input', field },
  }
}

describe('looksTyped', () => {
  it('accepts short text and rejects bytes, empty and cut-off previews', () => {
    expect(looksTyped('hunter2')).toBe(true)
    expect(looksTyped('pässwörd 1')).toBe(true)
    expect(looksTyped('')).toBe(false)
    expect(looksTyped('\u000Ebytes')).toBe(false)
    expect(looksTyped('\u0085bytes')).toBe(false)
    expect(looksTyped('x'.repeat(256))).toBe(false)
  })
})

describe('typedInputField', () => {
  const events = [
    change('username', 1),
    change('password', 2),
    change('note', 3, 'https://shop.test/other'),
  ]

  it('prefers the field named like the computed input, among fields not sent as-is', () => {
    expect(typedInputField({
      preview: 'secret',
      event: transform,
      events,
      requestTraces: [
        plain('username', 'demo'),
      ],
      inputKey: 'body./password',
    })).toBe('password')
  })

  it('matches a field whose value the request also sends as-is', () => {
    expect(typedInputField({
      preview: 'demo',
      event: transform,
      events,
      requestTraces: [
        plain('username', 'demo'),
      ],
      inputKey: 'body./password',
    })).toBe('username')
  })

  it('falls back to the latest changed field on the page, and to none without changes', () => {
    expect(typedInputField({
      preview: 'secret',
      event: transform,
      events,
      requestTraces: [],
      inputKey: 'body./sig',
    })).toBe('password')
    expect(typedInputField({
      preview: 'secret',
      event: transform,
      events: [
        change('note', 3, 'https://shop.test/other'),
      ],
      requestTraces: [],
      inputKey: 'body./password',
    })).toBeNull()
    expect(typedInputField({
      preview: 'secret',
      event: transform,
      events: [
        change('password', 20),
      ],
      requestTraces: [],
      inputKey: 'body./password',
    })).toBeNull()
  })
})
