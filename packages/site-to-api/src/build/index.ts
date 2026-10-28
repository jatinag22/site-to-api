/**
 * `build`: raw sessions → handoff folder. Runs every analysis stage in the order described in
 * docs/architecture.md. Stages are pure; this module owns ordering and file output.
 */
import type { ConfigSource } from '../config/load'
import type { ResolvedConfig } from '../config/schema'
import type { ClientState } from '../emit/handoff'
import type { Analysis, LoadedSession, Operation, ResponseInfo, SourceRef, SourceResolver } from '../model'
import type { ProbeReport } from '../model/probe'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'
import { buildChannels, channelExchanges, collectConnections } from '../analyze/channels'
import { classifyExchanges, createChannelScope } from '../analyze/classify'
import { traceValues } from '../analyze/correlate'
import { buildFlows } from '../analyze/flows'
import { createHtmlLocator, inferExtraction } from '../analyze/html'
import { buildOperations } from '../analyze/operations'
import { createRedactor } from '../analyze/redact'
import { inferOperationSchemas } from '../analyze/schema'
import { buildExcerpt, collectStaticStrings, createSourceResolver, createWrapperAwareResolver, findSourceEndpoints, isOpaqueFrame } from '../analyze/source'
import { buildAsyncApiDocuments, writeAsyncApiDocuments } from '../emit/asyncapi'
import { writeFlows } from '../emit/flows'
import { clientGap, writeHandoffDocs } from '../emit/handoff'
import { buildOpenApiDocuments, writeOpenApiDocuments } from '../emit/openapi'
import { generateClient } from '../gen'
import { loadSessions } from '../load'
import { applyProbeReport, minimizeLimit, notMinimized, readProbeReport, requirementsByOperation } from '../probe'
import { VERSION } from '../version'
import { alignWithRuntime } from './extract-check'
import { inHostFilter, unmatchedHostPatterns } from './hosts'
import { buildRecordFor, writeBuildRecord } from './record'

export { readBuildRecord, recordClientGenerated, stickyOptions } from './record'

export interface BuildOptions {
  config: ResolvedConfig
  cwd: string
  /**
   * Where each config value came from (from `loadConfig`). Values given as flags or environment
   * variables are recorded in `build.json` for `probe` and `gen` to reuse; none when omitted.
   */
  sources?: Record<string, ConfigSource>
  log?: (message: string) => void
}

export interface BuildResult {
  analysis: Analysis
  outDir: string
  files: string[]
  warnings: string[]
}

const TEXT_MEDIA = /^(?:text\/|application\/(?:xhtml\+xml|xml|csv))/

function isTextResponse(response: ResponseInfo): boolean {
  return response.schema === null && TEXT_MEDIA.test(response.mimeType)
}

/**
 * Fills `extract` on HTML/text responses from every captured sample of that status and type.
 * Specs the runtime rejects are dropped with a warning, so the mismatch is visible.
 */
function addExtraction(operations: Operation[], minSamples: number, warnings: string[]): Operation[] {
  return operations.map(operation => ({
    ...operation,
    responses: operation.responses.map((response) => {
      if (!isTextResponse(response))
        return response
      const samples = operation.exchanges
        .filter(exchange => exchange.response.status === response.status && exchange.response.body?.mimeType === response.mimeType)
        .flatMap(exchange => exchange.response.body?.text
          ? [
              { text: exchange.response.body.text, mimeType: response.mimeType },
            ]
          : [])
      const inferred = samples.length > 0
        ? inferExtraction(samples, { minSamples })
        : null
      if (!inferred)
        return { ...response, extract: null }
      // Generated clients run the runtime's extract(); make sure it reads the spec the same way.
      const aligned = alignWithRuntime(inferred.spec, samples.map(sample => sample.text))
      if (aligned.error !== null)
        warnings.push(`${operation.operationId}: the inferred record layout was rejected by the runtime's extract() (${aligned.error}); no extraction spec was written.`)
      return {
        ...response,
        extract: aligned.spec
          ? { ...inferred, spec: aligned.spec }
          : null,
      }
    }),
  }))
}

function refKey(ref: SourceRef): string {
  return `${ref.file}:${ref.line}:${ref.column}`
}

/** Where the page's code sends each operation from, deduplicated, most frequent first. */
function addCallSites(operations: Operation[], resolver: SourceResolver): Operation[] {
  return operations.map((operation) => {
    const counts = new Map<string, { ref: SourceRef, count: number }>()
    let opaque = false
    for (const exchange of operation.exchanges) {
      if (!exchange.initiator || exchange.initiator.stack.length === 0)
        continue
      const ref = resolver.callSite(exchange.initiator.stack, exchange.sessionId)
      if (!ref) {
        opaque ||= exchange.initiator.stack.some(isOpaqueFrame)
        continue
      }
      const entry = counts.get(refKey(ref)) ?? { ref, count: 0 }
      entry.count++
      counts.set(refKey(ref), entry)
    }
    const sentFrom = [
      ...counts.values(),
    ]
      .sort((a, b) => b.count - a.count || refKey(a.ref).localeCompare(refKey(b.ref)))
      .slice(0, 3)
      .map(entry => entry.ref)
    return sentFrom.length === 0 && opaque
      ? { ...operation, sentFrom, sourceUnavailable: true }
      : { ...operation, sentFrom }
  })
}

/** Every source reference that the output mentions, so each gets an excerpt. */
function referencedSources(analysis: Analysis): SourceRef[] {
  const refs: SourceRef[] = analysis.operations.flatMap(operation => operation.sentFrom)
  for (const channel of analysis.channels ?? []) {
    if (channel.sentFrom)
      refs.push(channel.sentFrom)
  }
  for (const flow of analysis.flows.flows) {
    for (const step of flow.steps) {
      if (step.sentFrom)
        refs.push(step.sentFrom)
    }
  }
  for (const value of analysis.flows.computedValues) {
    if (value.producedBy)
      refs.push(value.producedBy)
    if (value.calledFrom)
      refs.push(value.calledFrom)
  }
  return refs
}

/** The first session whose saved code can produce an excerpt for this location. */
async function excerptFor(ref: SourceRef, sessions: LoadedSession[]): Promise<{ path: string, content: string } | null> {
  for (const session of sessions) {
    const excerpt = await buildExcerpt(ref, sessions, session.meta.sessionId)
    if (excerpt)
      return excerpt
  }
  return null
}

/** Builds excerpts for every referenced location and records their paths on the references. */
async function addExcerpts(analysis: Analysis, sessions: LoadedSession[]): Promise<void> {
  const byKey = new Map<string, string | null>()
  for (const ref of referencedSources(analysis)) {
    const key = refKey(ref)
    if (!byKey.has(key)) {
      const excerpt = await excerptFor(ref, sessions)
      if (excerpt)
        analysis.excerpts.set(excerpt.path, excerpt.content)
      byKey.set(key, excerpt
        ? `source/${excerpt.path}`
        : null)
    }
    ref.excerpt = byKey.get(key) ?? null
  }
}

async function writeExcerpts(outDir: string, excerpts: Map<string, string>): Promise<string[]> {
  const files: string[] = []
  for (const [path, content] of [...excerpts].sort(([a], [b]) => a.localeCompare(b))) {
    const root = join(outDir, 'source')
    const target = join(root, path)
    const inside = relative(root, target)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
      continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    files.push(target)
  }
  return files
}

/** Hosts that ended up with at least one operation, sorted. */
function hostsOf(operations: Operation[]): string[] {
  return [
    ...new Set(operations.map(operation => operation.host)),
  ].sort()
}

interface Analyzed {
  analysis: Analysis
  probe: ProbeReport | null
}

async function analyze(config: ResolvedConfig, rawDir: string, outDir: string, log: (message: string) => void): Promise<Analyzed> {
  const loaded = await loadSessions(rawDir)
  log(`Loaded ${loaded.sessions.length} session(s), ${loaded.exchanges.length} requests`)
  const classified = classifyExchanges(loaded.exchanges, config.hosts)
  const resolver = await createSourceResolver(loaded.sessions)
  const sourceRoutes = await findSourceEndpoints(loaded.sessions)
  const staticStrings = await collectStaticStrings(loaded.sessions)
  const htmlLocator = createHtmlLocator()

  // WebSocket frames stand in as exchanges, so the redactor learns secrets sent over a socket and
  // tracing finds where the client's frame values came from (decision 0023).
  const sockets = channelExchanges(collectConnections(loaded.sessions))
  const redactor = createRedactor({
    exchanges: [
      ...classified.exchanges,
      ...sockets.exchanges,
    ],
    config: config.redact,
  })
  const wanted = inHostFilter(config.hosts)
  let operations = buildOperations(classified.exchanges, { sourceRoutes })
    .filter(operation => !operation.sourceOnly || wanted(operation.host))
  operations = inferOperationSchemas(operations, redactor)
  const warnings = [
    ...loaded.warnings,
    // WebSocket hosts count as captured: a pattern that only matches a socket host is not a typo.
    ...unmatchedHostPatterns([
      ...loaded.exchanges,
      ...sockets.exchanges,
    ], config.hosts),
  ]
  operations = addExtraction(operations, config.build.minExtractSamples, warnings)
  const operationIdByExchange = new Map(operations.flatMap(operation => operation.exchanges.map(exchange => [exchange.id, operation.operationId] as const)))
  const callSites = createWrapperAwareResolver(resolver, classified.exchanges, exchange => operationIdByExchange.get(exchange.id) ?? null)
  operations = addCallSites(operations, callSites)

  const allTraces = traceValues({
    exchanges: [
      ...classified.exchanges,
      ...sockets.exchanges,
    ],
    sessions: loaded.sessions,
    htmlLocator,
    staticStrings,
    minValueLength: config.build.minTraceValueLength,
  })
  const traces = allTraces.filter(trace => !sockets.standIns.has(trace.exchangeId))
  const flows = buildFlows({
    exchanges: classified.exchanges,
    operations,
    sessions: loaded.sessions,
    traces,
    sourceResolver: callSites,
    botProtection: classified.botProtection,
    redactor,
    toolVersion: VERSION,
  })

  const channels = buildChannels({
    channelExchanges: sockets,
    exchanges: classified.exchanges,
    operations,
    traces: allTraces,
    redactor,
    sourceRoutes,
    sourceResolver: callSites,
    inScope: createChannelScope(classified.exchanges, config.hosts),
  })

  const probe = await readProbeReport(outDir)
  if (probe) {
    flows.session = applyProbeReport(flows.session, probe)
    const requires = requirementsByOperation(probe)
    operations = operations.map(operation => ({ ...operation, requires: requires.get(`${operation.host} ${operation.operationId}`) ?? null }))
  }

  const analysis: Analysis = {
    sessions: loaded.sessions.map(session => session.meta.sessionId),
    hosts: hostsOf(operations),
    operations,
    flows,
    botProtection: classified.botProtection,
    channels,
    excerpts: new Map(),
    warnings,
  }
  if (config.build.excerpts)
    await addExcerpts(analysis, loaded.sessions)
  return { analysis, probe }
}

/**
 * Runs the whole analysis and writes the handoff folder, including `build.json` with the options
 * used. `client/` (with `--no-client`) and `probe.json` are kept.
 */
export async function buildHandoff(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? (() => {})
  const rawDir = resolve(options.cwd, options.config.rawDir)
  const outDir = resolve(options.cwd, options.config.outDir)
  const { analysis, probe } = await analyze(options.config, rawDir, outDir, log)

  // Remove generated files from a previous build so deleted operations do not linger.
  for (const stale of [
    'specs',
    'source',
    'AGENT.md',
    'API_MAP.md',
    'flows.json',
    'flows.md',
    'flows.schema.json',
  ])
    await rm(join(outDir, stale), { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const openApi = buildOpenApiDocuments(analysis)
  const asyncApi = await writeAsyncApiDocuments(outDir, buildAsyncApiDocuments(analysis.channels ?? [], analysis.sessions.length), [
    ...openApi.keys(),
  ])
  analysis.warnings.push(...asyncApi.warnings)
  const files = [
    ...await writeOpenApiDocuments(outDir, openApi),
    ...asyncApi.files,
    ...await writeFlows(outDir, analysis.flows, { operations: analysis.operations }),
    ...await writeExcerpts(outDir, analysis.excerpts),
  ]
  const warnings = [...analysis.warnings]
  let client: ClientState = 'none'
  if (options.config.gen.client && analysis.operations.length > 0) {
    const generated = await generateClient({ handoffDir: outDir, flows: analysis.flows })
    files.push(...generated.files.map(file => join(outDir, file)))
    warnings.push(...generated.warnings)
    client = 'current'
  }
  else if (analysis.operations.length === 0) {
    // Nothing left to describe: a client from an earlier build would point at operations that are gone.
    await rm(join(outDir, 'client'), { recursive: true, force: true })
  }
  else if (existsSync(join(outDir, 'client', 'index.ts'))) {
    client = 'stale'
    // Same sentence as the AGENT.md gap, so the terminal and the folder say the same thing.
    const stale = clientGap(client)
    if (stale !== null)
      warnings.push(stale)
  }
  files.push(
    ...await writeHandoffDocs(outDir, analysis, {
      toolVersion: VERSION,
      examples: options.config.redact.examples,
      probed: analysis.flows.session.some(entry => entry.probed),
      client,
      probe: probe
        ? {
            minimizePerHost: minimizeLimit(probe),
            notMinimized: notMinimized(probe, analysis.operations),
          }
        : null,
    }),
    await writeBuildRecord(outDir, buildRecordFor(options.config, options.sources ?? {}, VERSION)),
  )
  log(`Wrote ${files.length} files to ${outDir}`)
  return { analysis, outDir, files, warnings }
}

/** Analysis without writing anything, used by `probe` to get operations and exchanges. */
export async function analyzeCaptures(options: BuildOptions): Promise<Analysis> {
  const rawDir = resolve(options.cwd, options.config.rawDir)
  const outDir = resolve(options.cwd, options.config.outDir)
  return (await analyze(options.config, rawDir, outDir, options.log ?? (() => {}))).analysis
}
