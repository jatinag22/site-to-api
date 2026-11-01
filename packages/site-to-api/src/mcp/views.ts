/**
 * What each exploration tool returns (decision 0043), built from a loaded handoff folder. Pure:
 * every value here comes from the redacted specs, `flows.json` and `build.json`; examples are
 * served only by {@link examplesView}, and only when `build` masked them.
 */
import type { OperationEntry, OperationInput } from './catalog'
import type { Handoff } from './handoff'
import { dirname, relative } from 'pathe'
import { z } from 'zod'
import { responseSchemaName, sdkFunctionName } from '../emit/naming'
import { changesData, replaySkipReason } from '../probe/safety'
import { clientArguments, operationInputs, withoutExamples } from './catalog'

/** What the server was started with that changes what tools may do. */
export interface CallPolicy {
  /** `--allow-calls`: register `call_operation`. */
  allowCalls: boolean
  /** `--unsafe-methods`: let `call_operation` send writes. */
  unsafeMethods: boolean
  /** Requests per second for `call_operation`. */
  maxRps: number
}

/** Whether `call_operation` would send this operation, and if not, why. */
export function callVerdict(handoff: Handoff, entry: OperationEntry, policy: CallPolicy): { allowed: boolean, reason: string | null } {
  if (!policy.allowCalls)
    return { allowed: false, reason: 'calls are off; restart the server with --allow-calls to send requests' }
  if (!handoff.clientGenerated)
    return { allowed: false, reason: `${clientFolder(handoff)}/ has not been generated; run \`site-to-api gen\`` }
  const reason = replaySkipReason(entry, policy.unsafeMethods)
  return reason === null
    ? { allowed: true, reason: null }
    : { allowed: false, reason }
}

/** A search result row: enough to pick an operation without opening its spec. */
export function operationRow(entry: OperationEntry): Record<string, unknown> {
  return {
    operationId: entry.operationId,
    host: entry.host,
    method: entry.methodUnknown
      ? '? (method unknown)'
      : entry.method,
    path: entry.path,
    kind: entry.kind,
    summary: entry.summary,
    ...(entry.graphql
      ? {
          graphql: `${entry.graphql.operationType} ${entry.graphql.operationName ?? ''}`.trim(),
        }
      : {}),
    ...(entry.dispatch
      ? { dispatcher: `${entry.dispatch.parameter}=${entry.dispatch.value}` }
      : {}),
    ...(entry.sourceOnly
      ? { sourceOnly: true }
      : {}),
    changesData: changesData(entry),
  }
}

/** `list_hosts`: the hosts, their session needs and channels, the flows and computed values. */
export function hostsView(handoff: Handoff, policy: CallPolicy): Record<string, unknown> {
  return {
    handoff: {
      generatedBy: handoff.flows.generatedBy,
      sessions: handoff.flows.sessions.length,
      examples: handoff.build?.examples ?? 'unknown (no build.json)',
      client: handoff.clientGenerated
        ? 'generated'
        : 'not generated (run `site-to-api gen`)',
    },
    calls: policy.allowCalls
      ? { enabled: true, unsafeMethods: policy.unsafeMethods, maxRps: policy.maxRps }
      : { enabled: false },
    hosts: handoff.hosts.map((host) => {
      const operations = handoff.operations.filter(entry => entry.host === host.host)
      const session = handoff.flows.session.find(entry => entry.host === host.host) ?? null
      return {
        host: host.host,
        baseUrl: host.baseUrl,
        spec: `specs/${host.file}`,
        ...(host.asyncApiFile === null
          ? {}
          : { asyncApi: `specs/${host.asyncApiFile}` }),
        operations: operations.length,
        byKind: Object.fromEntries((['api', 'page', 'bot-protection'] as const).map(kind => [kind, operations.filter(entry => entry.kind === kind).length])),
        session,
        auth: host.auth,
        channels: handoff.channels
          .filter(channel => channel.file === host.asyncApiFile)
          .map(channel => ({ id: channel.id, url: channel.url, messageTypes: channel.messageTypes })),
      }
    }),
    flows: handoff.flows.flows.map(flow => ({
      id: flow.id,
      name: flow.name,
      trigger: `${flow.trigger.kind} ${flow.trigger.label}`,
      steps: flow.steps.length,
      seenInSessions: flow.seenInSessions,
    })),
    computedValues: handoff.flows.computedValues.map(value => ({
      id: value.id,
      operationId: value.operationId,
      input: value.input,
      api: value.api,
    })),
  }
}

/** The client folder seen from the folder that holds the handoff folder (`api-handoff/client`). */
function clientFolder(handoff: Handoff): string {
  return relative(dirname(handoff.dir), handoff.clientDir)
}

function clientView(handoff: Handoff, entry: OperationEntry, inputs: readonly OperationInput[]): Record<string, unknown> | null {
  // Bot-protection steps get no client function (decision 0008).
  if (entry.kind === 'bot-protection')
    return null
  const fn = sdkFunctionName(entry.operationId)
  return {
    generated: handoff.clientGenerated,
    setup: [
      `import { createSiteClient } from './${clientFolder(handoff)}/index.js' // from the folder that holds the handoff folder`,
      `const { sdk } = createSiteClient({ host: ${JSON.stringify(entry.host)} })`,
    ],
    call: `const result = await sdk.${fn}(${clientArguments(entry, inputs)})`,
    sdkFunction: fn,
    responseSchema: responseSchemaName(entry.operationId),
  }
}

/** `get_operation`: spec slice, inputs and their origins, session needs, client call. */
export function operationView(handoff: Handoff, entry: OperationEntry, policy: CallPolicy): Record<string, unknown> {
  const inputs = operationInputs(entry, handoff.flows)
  const session = handoff.flows.session.find(requirement => requirement.host === entry.host) ?? null
  const host = handoff.hosts.find(candidate => candidate.host === entry.host)
  const flows = new Map(handoff.flows.flows.map(flow => [flow.id, flow]))
  return {
    ...operationRow(entry),
    call: callVerdict(handoff, entry, policy),
    spec: {
      file: `specs/${entry.specFile}`,
      path: entry.path,
      method: entry.method.toLowerCase(),
      ...(entry.pathItemParameters.length > 0
        ? {
            pathItemParameters: withoutExamples(entry.pathItemParameters),
          }
        : {}),
      operation: withoutExamples(entry.operation),
      note: 'Examples are left out here; get_examples returns them.',
    },
    inputs,
    session: {
      host: session,
      probeFound: entry.requires === null
        ? 'not worked out by probe'
        : entry.requires,
      secured: entry.secured,
      ...(entry.secured && host !== undefined
        ? { auth: host.auth }
        : {}),
    },
    client: clientView(handoff, entry, inputs),
    flowSteps: entry.steps.map((reference) => {
      const [flowId = '', stepId = ''] = reference.split('.')
      const flow = flows.get(flowId)
      const step = flow?.steps.find(candidate => candidate.id === stepId)
      return { step: reference, flow: flow?.name ?? flowId, summary: step?.summary ?? '' }
    }),
    computedValues: handoff.flows.computedValues.filter(value => value.operationId === entry.operationId),
    source: entry.sources,
  }
}

/** `get_flow`: the flow with each step's method and path, and the computed values it uses. */
export function flowView(handoff: Handoff, flowId: string): Record<string, unknown> | string {
  const flow = handoff.flows.flows.find(candidate => candidate.id === flowId)
  if (flow === undefined)
    return `No flow ${JSON.stringify(flowId)}. Flows: ${handoff.flows.flows.map(candidate => candidate.id).join(', ') || 'none'}.`
  const operationIds = new Set(flow.steps.map(step => step.operationId))
  return {
    ...flow,
    steps: flow.steps.map((step) => {
      const entry = handoff.operations.find(candidate => candidate.operationId === step.operationId)
      return {
        ...step,
        ...(entry === undefined
          ? {}
          : { host: entry.host, method: entry.method, path: entry.path }),
      }
    }),
    computedValues: handoff.flows.computedValues.filter(value => operationIds.has(value.operationId)),
  }
}

const ParameterExamplesSchema = z.looseObject({
  name: z.string(),
  in: z.string(),
  example: z.unknown().optional(),
  examples: z.unknown().optional(),
  schema: z.looseObject({
    examples: z.array(z.unknown()).optional(),
  }).optional(),
})

const MediaExamplesSchema = z.looseObject({
  example: z.unknown().optional(),
  examples: z.record(z.string(), z.looseObject({
    value: z.unknown().optional(),
  })).optional(),
})

const ContentSchema = z.looseObject({
  content: z.record(z.string(), z.unknown()).optional(),
})

function mediaExamples(raw: unknown): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {}
  for (const [mediaType, media] of Object.entries(ContentSchema.safeParse(raw).data?.content ?? {})) {
    const parsed = MediaExamplesSchema.safeParse(media).data
    const values = [
      ...(parsed?.example === undefined
        ? []
        : [parsed.example]),
      ...Object.values(parsed?.examples ?? {}).map(example => example.value),
    ]
    if (values.length > 0)
      result[mediaType] = values
  }
  return result
}

/**
 * `get_examples`: the examples of the operation's parameters, request body and responses. Refused
 * when the folder's examples are raw (`--examples raw` copies captured values) or when no
 * `build.json` says how they were written.
 */
export function examplesView(handoff: Handoff, entry: OperationEntry): Record<string, unknown> | string {
  const mode = handoff.build?.examples
  if (mode === undefined)
    return 'This handoff folder has no build.json, so it is not known whether its examples are redacted. Run `site-to-api build` to rewrite it.'
  if (mode === 'raw')
    return 'This handoff folder was built with --examples raw: its examples are captured values, so the MCP server does not serve them. Run `site-to-api build` (masked examples are the default) to get redacted ones.'
  const parameters = entry.parameters.flatMap((raw) => {
    const parameter = ParameterExamplesSchema.safeParse(raw).data
    if (parameter === undefined)
      return []
    const values = [
      ...parameter.schema?.examples ?? [],
      ...(parameter.example === undefined
        ? []
        : [parameter.example]),
    ]
    return values.length === 0
      ? []
      : [
          { location: `${parameter.in}.${parameter.name}`, examples: values },
        ]
  })
  const responses: Record<string, Record<string, unknown[]>> = {}
  const rawResponses = z.record(z.string(), z.unknown()).safeParse(entry.operation.responses).data ?? {}
  for (const [status, response] of Object.entries(rawResponses)) {
    const examples = mediaExamples(response)
    if (Object.keys(examples).length > 0)
      responses[status] = examples
  }
  return {
    operationId: entry.operationId,
    host: entry.host,
    examples: mode,
    note: mode === 'none'
      ? 'This folder was built with --examples none, so there are no examples.'
      : 'Masked examples: secret and personal values are replaced by their shape.',
    parameters,
    requestBody: mediaExamples(entry.operation.requestBody),
    responses,
  }
}

/** Excerpt paths `flows.json` links to the operation: the code that sends it and its computed values. */
export function excerptsFor(handoff: Handoff, entry: OperationEntry): string[] {
  const paths = new Set<string>()
  for (const flow of handoff.flows.flows) {
    for (const step of flow.steps) {
      if (step.operationId === entry.operationId && step.sentFrom?.excerpt)
        paths.add(step.sentFrom.excerpt)
    }
  }
  for (const value of handoff.flows.computedValues) {
    if (value.operationId !== entry.operationId)
      continue
    for (const ref of [value.producedBy, value.calledFrom]) {
      if (ref?.excerpt)
        paths.add(ref.excerpt)
    }
  }
  return [...paths].filter(path => handoff.excerpts.includes(path)).sort()
}
