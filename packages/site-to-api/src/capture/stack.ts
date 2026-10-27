/**
 * Parses V8 `Error().stack` strings sent by the instrumentation. Parsing happens in Node rather
 * than in the page so it can be unit tested and so the page does as little work as possible.
 */
import type { StackFrame } from '../model'

/** `sourceURL` of the injected script; its frames are the tool itself, not the site. */
export const INSTRUMENT_SOURCE_URL = 'site-to-api-instrument.js'

const LOCATION = /^(.*):(\d+):(\d+)$/
/** The call site inside `eval at fn (url:line:col)`, which is where the evaluated code came from. */
const EVAL_ORIGIN = /\(([^()]+):(\d+):(\d+)\)/

function parseLocation(location: string): { url: string, line: number, column: number } | null {
  let match = LOCATION.exec(location)
  if (location.startsWith('eval at '))
    match = EVAL_ORIGIN.exec(location)
  if (!match)
    return null
  const [, url, line, column] = match
  if (url === undefined || line === undefined || column === undefined || url === '' || url === '<anonymous>')
    return null
  return {
    url,
    line: Number(line),
    column: Number(column),
  }
}

function parseLine(raw: string): StackFrame | null {
  const line = raw.trim()
  if (!line.startsWith('at '))
    return null
  const body = line.slice(3).replace(/^async /, '')
  let functionName: string | null = null
  let location = body
  const open = body.indexOf(' (')
  if (open !== -1 && body.endsWith(')')) {
    functionName = body.slice(0, open)
    location = body.slice(open + 2, -1)
  }
  const parsed = parseLocation(location)
  if (!parsed)
    return null
  if (functionName === '<anonymous>' || functionName === '')
    functionName = null
  return { ...parsed, functionName }
}

/**
 * Converts a V8 stack string into frames, dropping the message line, native frames without a
 * location and frames that belong to the injected instrumentation.
 */
export function parseV8Stack(stack: string): StackFrame[] {
  const frames: StackFrame[] = []
  for (const raw of stack.split('\n')) {
    const frame = parseLine(raw)
    if (frame && !frame.url.endsWith(INSTRUMENT_SOURCE_URL))
      frames.push(frame)
  }
  return frames
}
