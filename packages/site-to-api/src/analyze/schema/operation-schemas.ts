/**
 * Fills each operation's query, headers, cookies, request body and responses from its exchanges.
 */
import type { Body, Exchange, HeaderInfo, JsonSchema, NameValue, Operation, ParamInfo, RedactContext, Redactor, ResponseInfo } from '../../model'
import type { InferOptions } from './infer'
import { coerceStrings, inferSchema, inferStringSchema } from './infer'

/**
 * Request headers the browser or the HTTP stack sets on its own. A client never needs to send
 * them by hand, so they stay out of the specs. Everything else (referer, origin, `x-*`, accept,
 * user-agent, content-type) is kept.
 */
const BROWSER_MANAGED_HEADERS: readonly string[] = [
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'upgrade',
  'accept-encoding',
  'priority',
  'upgrade-insecure-requests',
  'cookie',
  'sec-fetch-*',
  'sec-ch-*',
]

/** Text request bodies longer than this get no example. */
const MAX_TEXT_EXAMPLE_LENGTH = 2000

export function isBrowserManagedHeader(name: string): boolean {
  return BROWSER_MANAGED_HEADERS.some(entry => entry.endsWith('*')
    ? name.startsWith(entry.slice(0, -1))
    : name === entry)
}

function namesInOrder(lists: NameValue[][]): string[] {
  const names = new Set<string>()
  for (const list of lists) {
    for (const item of list)
      names.add(item.name)
  }
  return [...names]
}

function enumGuard(redactor: Redactor, context: RedactContext): InferOptions {
  return {
    allowEnumValue: value => redactor.value(value, context) === value,
  }
}

function withExamples(schema: JsonSchema, examples: unknown[]): JsonSchema {
  return examples.length > 0
    ? { ...schema, examples }
    : schema
}

function inferParams(exchanges: Exchange[], pick: (exchange: Exchange) => NameValue[], where: RedactContext['in'], redactor: Redactor): ParamInfo[] {
  const lists = exchanges.map(pick)
  return namesInOrder(lists).map((name) => {
    const context: RedactContext = { in: where, name }
    const samples: Array<{ value: string, sessionId: string }> = []
    let repeated = false
    let present = 0
    lists.forEach((list, index) => {
      const values = list.filter(item => item.name === name).map(item => item.value)
      if (values.length === 0)
        return
      present++
      repeated ||= values.length > 1
      for (const value of values)
        samples.push({ value, sessionId: exchanges[index]!.sessionId })
    })
    const item = inferStringSchema(samples, enumGuard(redactor, context))
    const examples = redactor.examples(coerceStrings(samples.map(sample => sample.value)), context)
    return {
      name,
      required: present === exchanges.length,
      schema: repeated
        ? { type: 'array', items: item }
        : withExamples(item, examples),
    }
  })
}

function inferHeaders(exchanges: Exchange[], redactor: Redactor): HeaderInfo[] {
  const lists = exchanges.map(exchange => exchange.request.headers.filter(header => !isBrowserManagedHeader(header.name)))
  return namesInOrder(lists).map((name) => {
    const context: RedactContext = { in: 'header', name }
    const samples = lists.flatMap((list, index) => list
      .filter(item => item.name === name)
      .map(item => ({ value: item.value, sessionId: exchanges[index]!.sessionId })))
    const present = lists.filter(list => list.some(item => item.name === name)).length
    const distinct = new Set(samples.map(sample => sample.value))
    const constant = present === exchanges.length && distinct.size === 1
    let schema = withExamples(inferSchema(samples, enumGuard(redactor, context)), redactor.examples(samples.map(sample => sample.value), context))
    const only = samples[0]?.value
    // A constant that the redactor would change is a secret: it must not become a default.
    if (constant && only !== undefined && redactor.value(only, context) === only)
      schema = { ...schema, default: only }
    return {
      name,
      required: present === exchanges.length,
      constant,
      schema,
    }
  })
}

function inferCookies(exchanges: Exchange[]): ParamInfo[] {
  const lists = exchanges.map(exchange => exchange.request.cookies)
  return namesInOrder(lists).map(name => ({
    name,
    required: lists.every(list => list.some(item => item.name === name)),
    schema: { type: 'string' },
  }))
}

function mostCommonMimeType(bodies: Body[]): string {
  const counts = new Map<string, number>()
  for (const body of bodies)
    counts.set(body.mimeType, (counts.get(body.mimeType) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
}

function formObject(form: NameValue[]): Record<string, string> {
  return Object.fromEntries(form.map(field => [field.name, field.value]))
}

function inferFormSchema(items: Array<{ form: NameValue[], sessionId: string }>, redactor: Redactor): JsonSchema {
  const names = namesInOrder(items.map(item => item.form))
  const properties: Record<string, JsonSchema> = {}
  for (const name of names) {
    const samples = items.flatMap(item => item.form
      .filter(field => field.name === name)
      .map(field => ({ value: field.value, sessionId: item.sessionId })))
    properties[name] = inferStringSchema(samples, enumGuard(redactor, { in: 'form', name }))
  }
  const required = names.filter(name => items.every(item => item.form.some(field => field.name === name)))
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

function inferRequestBody(exchanges: Exchange[], redactor: Redactor): Operation['requestBody'] {
  const withBody = exchanges.filter((exchange): exchange is Exchange & { request: { body: Body } } => exchange.request.body !== null)
  if (withBody.length === 0)
    return null
  const mimeType = mostCommonMimeType(withBody.map(exchange => exchange.request.body))
  const group = withBody.filter(exchange => exchange.request.body.mimeType === mimeType)
  const bodies = group.map(exchange => exchange.request.body)

  if (bodies.every(body => body.json !== undefined)) {
    const context: RedactContext = { in: 'body' }
    return {
      mimeType,
      schema: inferSchema(group.map(exchange => ({ value: exchange.request.body.json, sessionId: exchange.sessionId })), enumGuard(redactor, context)),
      examples: redactor.examples(bodies.map(body => body.json), context),
    }
  }
  if (bodies.every(body => body.form !== null)) {
    const items = group.map(exchange => ({ form: exchange.request.body.form ?? [], sessionId: exchange.sessionId }))
    return {
      mimeType,
      schema: inferFormSchema(items, redactor),
      examples: redactor.examples(items.map(item => formObject(item.form)), { in: 'form' }),
    }
  }
  if (bodies.every(body => body.text !== null)) {
    const texts = bodies.map(body => body.text ?? '').filter(text => text.length <= MAX_TEXT_EXAMPLE_LENGTH)
    return {
      mimeType,
      schema: { type: 'string' },
      examples: redactor.examples(texts, { in: 'body' }),
    }
  }
  return {
    mimeType,
    schema: { type: 'string', format: 'binary' },
    examples: [],
  }
}

function inferResponses(exchanges: Exchange[], redactor: Redactor): ResponseInfo[] {
  const groups = new Map<string, { status: number, mimeType: string, exchanges: Exchange[] }>()
  for (const exchange of exchanges) {
    const mimeType = exchange.response.body?.mimeType ?? ''
    const key = `${exchange.response.status} ${mimeType}`
    let group = groups.get(key)
    if (!group) {
      group = { status: exchange.response.status, mimeType, exchanges: [] }
      groups.set(key, group)
    }
    group.exchanges.push(exchange)
  }
  return [
    ...groups.values(),
  ]
    .sort((a, b) => a.status - b.status || a.mimeType.localeCompare(b.mimeType))
    .map(({ status, mimeType, exchanges: members }) => {
      const bodies = members.map(exchange => exchange.response.body)
      const isJson = bodies.length > 0 && bodies.every(body => body !== null && body.json !== undefined)
      if (!isJson) {
        return {
          status,
          mimeType,
          schema: null,
          extract: null,
          examples: [],
        }
      }
      const context: RedactContext = { in: 'response-body' }
      return {
        status,
        mimeType,
        schema: inferSchema(members.map(exchange => ({ value: exchange.response.body?.json, sessionId: exchange.sessionId })), enumGuard(redactor, context)),
        extract: null,
        examples: redactor.examples(bodies.map(body => body?.json), context),
      }
    })
}

function enrichPathParams(operation: Operation, redactor: Redactor): Operation['pathParams'] {
  return operation.pathParams.map((param) => {
    const samples = operation.exchanges
      .map(exchange => ({ value: exchange.request.path.split('/').filter(segment => segment !== '')[param.index], sessionId: exchange.sessionId }))
      .filter((sample): sample is { value: string, sessionId: string } => sample.value !== undefined)
      .map(sample => ({
        value: safeDecode(sample.value),
        sessionId: sample.sessionId,
      }))
    if (samples.length === 0)
      return param
    const context: RedactContext = { in: 'path', name: param.name }
    // Path values identify one resource; an enum would wrongly limit the client to those seen.
    const schema = inferStringSchema(samples, {
      allowEnumValue: () => false,
    })
    return {
      ...param,
      schema: withExamples(schema, redactor.examples(coerceStrings(samples.map(sample => sample.value)), context)),
    }
  })
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

/**
 * Infers the request and response shapes of every observed operation. Examples go through the
 * redactor; operations found only in source code are returned unchanged.
 */
export function inferOperationSchemas(operations: Operation[], redactor: Redactor): Operation[] {
  return operations.map((operation) => {
    const { exchanges } = operation
    if (exchanges.length === 0)
      return operation
    return {
      ...operation,
      pathParams: enrichPathParams(operation, redactor),
      query: inferParams(exchanges, exchange => exchange.request.query, 'query', redactor),
      headers: inferHeaders(exchanges, redactor),
      cookies: inferCookies(exchanges),
      requestBody: inferRequestBody(exchanges, redactor),
      responses: inferResponses(exchanges, redactor),
    }
  })
}
