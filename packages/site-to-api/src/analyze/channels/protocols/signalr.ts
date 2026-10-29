/**
 * ASP.NET Core SignalR, JSON hub protocol (decision 0038). Every record ends with the record
 * separator `\x1e`, and a frame may carry several. The client opens with
 * `{"protocol":"json","version":1}`, the server answers `{}` (or `{"error":…}`); then
 * `{"type":1,"target":"…","arguments":[…]}` invocations, 2 stream items, 3 completions, 4 stream
 * invocations, 5 cancels, 6 pings, 7 close, 8 ack and 9 sequence messages.
 */
import type { DecodedMessage, DecoderSession, ProtocolDecoder, RawFrame } from './types'
import { argumentsPayload, isRecord, message, parseJson } from './types'

const RS = '\x1E'

const TYPES: Record<number, { frame: string, role: DecodedMessage['role'] }> = {
  1: { frame: 'invocation', role: null },
  2: { frame: 'stream item', role: 'data' },
  3: { frame: 'completion', role: 'data' },
  4: { frame: 'stream invocation', role: null },
  5: { frame: 'cancel invocation', role: 'unsubscribe' },
  6: { frame: 'ping', role: 'keepalive' },
  7: { frame: 'close', role: 'unsubscribe' },
  8: { frame: 'ack', role: 'keepalive' },
  9: { frame: 'sequence', role: 'keepalive' },
}

class SignalrSession implements DecoderSession {
  /** Hub method per invocation id, so a completion is named after the call it completes. */
  private readonly targets = new Map<string, string>()
  private protocolVersion: string | null = null
  private handshakeAnswered = false

  read(frame: RawFrame): DecodedMessage[] | null {
    if (frame.binary || !frame.data.endsWith(RS))
      return null
    const records = frame.data.split(RS).slice(0, -1)
    const decoded: DecodedMessage[] = []
    for (const record of records) {
      const one = this.readRecord(frame, record)
      if (one === null)
        return null
      decoded.push(one)
    }
    return decoded
  }

  version(): string | null {
    return this.protocolVersion
  }

  /** An invocation names its hub method; the method is remembered for the completion. */
  private invocation(data: string, json: Record<string, unknown>, type: { frame: string, role: DecodedMessage['role'] }, invocationId: string | null): DecodedMessage | null {
    if (typeof json.target !== 'string' || !Array.isArray(json.arguments))
      return null
    if (invocationId !== null)
      this.targets.set(invocationId, json.target)
    const id = invocationId === null
      ? ''
      : '"invocationId":"<id>",'
    return message({
      data,
      frame: type.frame,
      name: [json.target],
      role: type.role,
      wire: `{"type":${String(json.type)},${id}"target":"{0}","arguments":<payload>}\\x1e`,
      payload: argumentsPayload(json.arguments),
      strong: true,
    })
  }

  private readRecord(frame: RawFrame, record: string): DecodedMessage | null {
    const json = parseJson(record)
    if (!isRecord(json))
      return null
    const data = `${record}${RS}`
    if (frame.direction === 'sent' && typeof json.protocol === 'string' && typeof json.version === 'number') {
      this.protocolVersion = `${json.protocol} ${json.version}`
      return message({
        data,
        frame: 'handshake',
        name: ['handshake'],
        role: 'init',
        wire: '<payload>\\x1e',
        payload: json,
        strong: true,
      })
    }
    if (frame.direction === 'received' && !this.handshakeAnswered && json.type === undefined) {
      this.handshakeAnswered = true
      return message({
        data,
        frame: 'handshake response',
        name: ['handshake response'],
        role: 'init',
        wire: '<payload>\\x1e',
        payload: json,
        strong: true,
      })
    }
    const type = typeof json.type === 'number'
      ? TYPES[json.type]
      : undefined
    if (type === undefined)
      return null
    const invocationId = typeof json.invocationId === 'string'
      ? json.invocationId
      : null
    if (json.type === 1 || json.type === 4)
      return this.invocation(data, json, type, invocationId)
    const { type: _type, ...payload } = json
    const target = invocationId === null
      ? undefined
      : this.targets.get(invocationId)
    return message({
      data,
      frame: type.frame,
      name: [
        target === undefined
          ? type.frame
          : `${target} ${type.frame}`,
      ],
      role: type.role,
      wire: `{"type":${json.type},…}\\x1e`,
      payload: Object.keys(payload).length > 0
        ? payload
        : undefined,
      strong: true,
    })
  }
}

export const signalr: ProtocolDecoder = {
  id: 'signalr',
  hint: () => null,
  handshakeVersion: () => null,
  start: () => new SignalrSession(),
}
