/**
 * Turns one live answer into the verdict for its operation (decision 0044). Pure: the answer is
 * already read, nothing is sent here.
 */
import type { Operation, ResponseInfo } from '../model'
import type { OperationCheck } from '../model/check'
import type { LiveReplay } from '../probe'
import type { SchemaDiff } from './diff'
import { diffAgainstSchema } from './diff'

type Answered = Extract<LiveReplay, { kind: 'answered' }>

function mediaType(value: string | null): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase()
}

/** The documented response a live answer should be read against, preferring the captured media type. */
function documentedResponse(operation: Operation, status: number, mimeType: string): ResponseInfo | null {
  const sameStatus = operation.responses.filter(response => response.status === status)
  return sameStatus.find(response => response.mimeType === mimeType) ?? sameStatus[0] ?? null
}

/** Parses the live body as JSON and diffs it; a body that is not JSON is a change at the root. */
function diffBody(schema: NonNullable<ResponseInfo['schema']>, text: string): SchemaDiff {
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    return {
      added: [],
      removed: [],
      typeChanged: [
        { path: '$', expected: 'JSON', actual: 'not JSON' },
      ],
    }
  }
  return diffAgainstSchema(schema, body)
}

/** Without a JSON schema (HTML, text) only the media type can be compared. */
function mediaTypeChange(response: ResponseInfo | null, live: Answered, statusChanged: boolean): SchemaDiff {
  const wanted = response?.mimeType
  const got = mediaType(live.contentType)
  const differs = !statusChanged && wanted !== undefined && wanted !== '' && got !== '' && wanted !== got
  return {
    added: [],
    removed: [],
    typeChanged: differs
      ? [
          { path: '$', expected: wanted, actual: got },
        ]
      : [],
  }
}

function base(operation: Operation): Pick<OperationCheck, 'operationId' | 'host' | 'method' | 'path'> {
  return {
    operationId: operation.operationId,
    host: operation.host,
    method: operation.method,
    path: operation.path,
  }
}

/** The verdict for an operation whose replay got no answer. */
export function unreachableCheck(operation: Operation, expected: number, error: string): OperationCheck {
  return {
    ...base(operation),
    verdict: 'unreachable',
    status: { expected, actual: null },
    added: [],
    removed: [],
    typeChanged: [],
    note: `Could not reach ${operation.host} (${error}). Nothing was concluded about this operation.`,
  }
}

/**
 * Compares a live answer with the operation's captured status and response schema.
 * A refused answer (bot protection, a session the site no longer accepts) says nothing about the
 * API, so it is `blocked`, not drift. Anything else that differs is drift.
 */
export function compareLive(operation: Operation, live: Answered): OperationCheck {
  const expected = live.exchange.response.status
  const status = { expected, actual: live.status }
  if (live.refusal) {
    const advice = live.refusal.kind === 'bot-protection'
      ? 'This request needs a real browser; check cannot compare it.'
      : 'The captured session was not accepted any more; capture again, then build.'
    return {
      ...base(operation),
      verdict: 'blocked',
      status,
      added: [],
      removed: [],
      typeChanged: [],
      rejection: live.refusal.kind,
      note: `Refused (${live.refusal.evidence}). ${advice}`,
    }
  }

  const changed = live.status !== expected
  const response = documentedResponse(operation, live.status, live.exchange.response.body?.mimeType ?? '')
  const note = changed
    ? `status ${live.status}, captured ${expected}`
    : null

  // A different status is compared with its own documented body when there is one; an
  // undocumented error body has no schema to check.
  const body = response?.schema
    ? diffBody(response.schema, live.text)
    : mediaTypeChange(response, live, changed)
  const { added, removed, typeChanged } = body

  const drift = changed || added.length > 0 || removed.length > 0 || typeChanged.length > 0
  return {
    ...base(operation),
    verdict: drift
      ? 'drift'
      : 'ok',
    status,
    added,
    removed,
    typeChanged,
    note,
  }
}
