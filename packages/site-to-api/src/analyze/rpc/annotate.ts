/**
 * tRPC and Connect RPC calls (decision 0051). Each call is marked with what it calls, and a
 * batched tRPC request (`/api/trpc/a,b?batch=1&input={"0":…,"1":…}`) becomes one stand-in
 * exchange per procedure, an unbatched call with its own input and its element of the response
 * array, so every later stage sees one procedure per exchange.
 */
import type { Body, Exchange, NameValue, RpcRequest } from '../../model'

/** `…/trpc/<procedures>`: what follows the `trpc` segment. */
const TRPC_PATH = /^(.*\/trpc\/)(.+)$/
/** One procedure path: `viewer.me`, `slots/getAvailabilityRanges`. */
const TRPC_PROCEDURE = /^[\w-]+(?:[./][\w-]+)*$/
/** More procedures than this in one batch is not a call a page makes. */
const MAX_BATCH = 64

/** `/<package.Service>/<Method>`, with an optional path prefix. */
const CONNECT_PATH = /^(?:\/[\w.-]+)*\/((?:[A-Z_]\w*\.)+[A-Z_]\w*)\/([A-Z_]\w*)$/i
const CONNECT_CONTENT_TYPES = /^application\/(?:connect\+)?(?:json|proto)\b/i

function header(exchange: Exchange, name: string): string | undefined {
  return exchange.request.headers.find(item => item.name.toLowerCase() === name)?.value
}

function query(exchange: Exchange, name: string): string | undefined {
  return exchange.request.query.find(item => item.name === name)?.value
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  }
  catch {
    return text
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** superjson's envelope: `{"json": …}` with an optional `meta`, nothing else. */
function isSuperjson(value: unknown): boolean {
  return isRecord(value) && 'json' in value && Object.keys(value).every(key => key === 'json' || key === 'meta')
}

/** A tRPC answer: `{"result": {"data": …}}` or `{"error": …}`. */
function isTrpcAnswer(value: unknown): boolean {
  return isRecord(value) && ((isRecord(value.result) && 'data' in value.result) || isRecord(value.error))
}

function jsonBody(mimeType: string, value: unknown): Body {
  return {
    mimeType,
    text: JSON.stringify(value),
    base64: null,
    json: value,
    form: null,
  }
}

/** The input of a tRPC call: the `input` query parameter (GET) or the JSON body. */
function trpcInput(exchange: Exchange): { value: unknown, present: boolean } {
  const text = query(exchange, 'input')
  if (text !== undefined) {
    return {
      value: parseJson(text),
      present: true,
    }
  }
  const body = exchange.request.body
  return body?.json === undefined
    ? { value: undefined, present: false }
    : { value: body.json, present: true }
}

interface TrpcCall {
  prefix: string
  procedures: string[]
  batch: boolean
}

/**
 * The procedures of a tRPC request, or null when it is not one: a path under a `trpc` segment
 * and either `batch=1`, a JSON `input`, or a tRPC-shaped answer.
 */
function trpcCall(exchange: Exchange): TrpcCall | null {
  const match = TRPC_PATH.exec(exchange.request.path)
  if (match === null)
    return null
  const [, prefix = '', raw = ''] = match
  const rest = safeDecode(raw)
  const batch = query(exchange, 'batch') === '1'
  // A batch lists its procedures in the last segment; a router path before it (`slots/`) is
  // shared by all of them.
  const slash = rest.lastIndexOf('/') + 1
  const directory = rest.slice(0, slash)
  const procedures = batch
    ? rest.slice(slash).split(',').map(name => `${directory}${name}`)
    : [rest]
  if (procedures.length > MAX_BATCH || !procedures.every(procedure => TRPC_PROCEDURE.test(procedure)))
    return null
  const input = query(exchange, 'input')
  const answer = exchange.response.body?.json
  const shaped = Array.isArray(answer)
    ? answer.length > 0 && answer.every(isTrpcAnswer)
    : isTrpcAnswer(answer)
  if (!batch && !shaped && (input === undefined || parseJson(input) === undefined))
    return null
  return { prefix, procedures, batch }
}

function withoutParams(params: readonly NameValue[], names: ReadonlySet<string>): NameValue[] {
  return params.filter(param => !names.has(param.name))
}

/** One unbatched stand-in for procedure `index` of a batch. */
function trpcStandIn(exchange: Exchange, call: TrpcCall, index: number): Exchange | null {
  const procedure = call.procedures[index]
  if (procedure === undefined)
    return null
  const input = trpcInput(exchange)
  const element: unknown = isRecord(input.value)
    ? input.value[String(index)]
    : undefined
  const answers = exchange.response.body?.json
  const answer: unknown = Array.isArray(answers) && answers.length === call.procedures.length
    ? answers[index]
    : undefined
  const viaQuery = query(exchange, 'input') !== undefined
  const queryParams = [
    ...withoutParams(exchange.request.query, new Set(['batch', 'input'])),
    ...(viaQuery && element !== undefined
      ? [
          {
            name: 'input',
            value: JSON.stringify(element),
          },
        ]
      : []),
  ]
  const path = `${call.prefix}${procedure}`
  const search = new URLSearchParams(queryParams.map(param => [param.name, param.value])).toString()
  const origin = /^[a-z][\w+.-]*:\/\/[^/]+/i.exec(exchange.request.url)?.[0] ?? ''
  const requestBody = exchange.request.body
  const responseBody = exchange.response.body
  return {
    ...exchange,
    id: `${exchange.id}:trpc:${index}`,
    request: {
      ...exchange.request,
      url: `${origin}${path}${search === ''
        ? ''
        : `?${search}`}`,
      path,
      query: queryParams,
      body: requestBody && !viaQuery
        ? jsonBody(requestBody.mimeType, element)
        : requestBody,
    },
    response: {
      ...exchange.response,
      body: responseBody && answer !== undefined
        ? jsonBody(responseBody.mimeType, answer)
        : responseBody,
    },
    rpc: trpcRequest(procedure, viaQuery, element),
  }
}

function trpcRequest(procedure: string, viaQuery: boolean, input: unknown): RpcRequest {
  return {
    protocol: 'trpc',
    procedure,
    jsonParam: viaQuery
      ? 'input'
      : null,
    superjson: isSuperjson(input),
  }
}

/**
 * The Connect method of a request, or null: a `/<package.Service>/<Method>` path and either the
 * `connect-protocol-version: 1` header or a GET with `connect=v1`.
 */
function connectRequest(exchange: Exchange): RpcRequest | null {
  const match = CONNECT_PATH.exec(exchange.request.path)
  if (match === null)
    return null
  const [, service = '', method = ''] = match
  const get = exchange.request.method === 'GET' && query(exchange, 'connect') === 'v1'
  const post = exchange.request.method === 'POST'
    && header(exchange, 'connect-protocol-version') === '1'
    && CONNECT_CONTENT_TYPES.test(header(exchange, 'content-type') ?? exchange.request.body?.mimeType ?? '')
  if (!get && !post)
    return null
  const jsonMessage = get && query(exchange, 'encoding') === 'json' && query(exchange, 'base64') !== '1'
  return {
    protocol: 'connect',
    procedure: `${service}/${method}`,
    jsonParam: jsonMessage
      ? 'message'
      : null,
    superjson: false,
  }
}

/**
 * Sets `rpc` on every tRPC and Connect call and replaces each batched tRPC call by one stand-in
 * per procedure, in place of the original and in batch order. GraphQL calls (already marked)
 * and everything else are returned unchanged.
 */
export function annotateRpc(exchanges: Exchange[]): Exchange[] {
  return exchanges.flatMap((exchange) => {
    if (exchange.kind !== 'api' || exchange.graphql !== undefined)
      return [exchange]
    const connect = connectRequest(exchange)
    if (connect !== null) {
      return [
        { ...exchange, rpc: connect },
      ]
    }
    const call = trpcCall(exchange)
    if (call === null)
      return [exchange]
    if (!call.batch) {
      const procedure = call.procedures[0] ?? ''
      return [
        {
          ...exchange,
          rpc: trpcRequest(procedure, query(exchange, 'input') !== undefined, trpcInput(exchange).value),
        },
      ]
    }
    return call.procedures.flatMap((_, index) => {
      const standIn = trpcStandIn(exchange, call, index)
      return standIn === null
        ? []
        : [standIn]
    })
  })
}
