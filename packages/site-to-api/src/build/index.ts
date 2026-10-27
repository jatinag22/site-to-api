/**
 * `build`: raw sessions → handoff folder. Runs every analysis stage in the order described in
 * docs/architecture.md. Stages are pure; this module owns ordering and file output.
 */
import type { ResolvedConfig } from '../config/schema'
import type { Analysis, LoadedSession, Operation, ResponseInfo, SourceRef, SourceResolver } from '../model'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'pathe'
import { classifyExchanges } from '../analyze/classify'
import { traceValues } from '../analyze/correlate'
import { buildFlows } from '../analyze/flows'
import { createHtmlLocator, inferExtraction } from '../analyze/html'
import { buildOperations } from '../analyze/operations'
import { createRedactor } from '../analyze/redact'
import { inferOperationSchemas } from '../analyze/schema'
import { buildExcerpt, collectStaticStrings, createSourceResolver, findSourceEndpoints } from '../analyze/source'
import { writeFlows } from '../emit/flows'
import { writeHandoffDocs } from '../emit/handoff'
import { buildOpenApiDocuments, writeOpenApiDocuments } from '../emit/openapi'
import { generateClient } from '../gen'
import { loadSessions } from '../load'
import { applyProbeReport, readProbeReport, requirementsByOperation } from '../probe'
import { VERSION } from '../version'

export interface BuildOptions {
  config: ResolvedConfig
  cwd: string
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

/** Fills `extract` on HTML/text responses from every captured sample of that status and type. */
function addExtraction(operations: Operation[], minSamples: number): Operation[] {
  return operations.map(operation => ({
    ...operation,
    responses: operation.responses.map((response) => {
      if (!isTextResponse(response))
        return response
      const samples = operation.exchanges
        .filter(exchange => exchange.response.status === response.status && exchange.response.body?.mimeType === response.mimeType)
        .flatMap(exchange => exchange.response.body?.text ? [{ text: exchange.response.body.text, mimeType: response.mimeType }] : [])
      const extract = samples.length > 0 ? inferExtraction(samples, { minSamples }) : null
      return { ...response, extract }
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
    for (const exchange of operation.exchanges) {
      if (!exchange.initiator || exchange.initiator.stack.length === 0)
        continue
      const ref = resolver.callSite(exchange.initiator.stack, exchange.sessionId)
      if (!ref)
        continue
      const entry = counts.get(refKey(ref)) ?? { ref, count: 0 }
      entry.count++
      counts.set(refKey(ref), entry)
    }
    const sentFrom = [...counts.values()]
      .sort((a, b) => b.count - a.count || refKey(a.ref).localeCompare(refKey(b.ref)))
      .slice(0, 3)
      .map(entry => entry.ref)
    return { ...operation, sentFrom }
  })
}

/** Every source reference that the output mentions, so each gets an excerpt. */
function referencedSources(analysis: Analysis): SourceRef[] {
  const refs: SourceRef[] = analysis.operations.flatMap(operation => operation.sentFrom)
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

/** Builds excerpts for every referenced location and records their paths on the references. */
async function addExcerpts(analysis: Analysis, sessions: LoadedSession[]): Promise<void> {
  const sessionFor = new Map<string, string>()
  for (const operation of analysis.operations) {
    for (const exchange of operation.exchanges) {
      for (const frame of exchange.initiator?.stack ?? [])
        sessionFor.set(frame.url, exchange.sessionId)
    }
  }
  const fallbackSession = sessions[0]?.meta.sessionId
  const byKey = new Map<string, string | null>()
  for (const ref of referencedSources(analysis)) {
    const key = refKey(ref)
    if (!byKey.has(key)) {
      const sessionId = sessionFor.get(ref.file) ?? fallbackSession
      const excerpt = sessionId ? await buildExcerpt(ref, sessions, sessionId) : null
      if (excerpt)
        analysis.excerpts.set(excerpt.path, excerpt.content)
      byKey.set(key, excerpt ? `source/${excerpt.path}` : null)
    }
    ref.excerpt = byKey.get(key) ?? null
  }
}

async function writeExcerpts(outDir: string, excerpts: Map<string, string>): Promise<string[]> {
  const files: string[] = []
  for (const [path, content] of [...excerpts].sort(([a], [b]) => a.localeCompare(b))) {
    const target = join(outDir, 'source', path)
    if (!target.startsWith(join(outDir, 'source')))
      continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    files.push(target)
  }
  return files
}

/** Hosts that ended up with at least one operation, sorted. */
function hostsOf(operations: Operation[]): string[] {
  return [...new Set(operations.map(operation => operation.host))].sort()
}

async function analyze(config: ResolvedConfig, rawDir: string, outDir: string, log: (message: string) => void): Promise<Analysis> {
  const loaded = await loadSessions(rawDir)
  log(`Loaded ${loaded.sessions.length} session(s), ${loaded.exchanges.length} requests`)
  const classified = classifyExchanges(loaded.exchanges, config.hosts)
  const resolver = await createSourceResolver(loaded.sessions)
  const sourceRoutes = await findSourceEndpoints(loaded.sessions)
  const staticStrings = await collectStaticStrings(loaded.sessions)
  const htmlLocator = createHtmlLocator()

  const redactor = createRedactor({ exchanges: classified.exchanges, config: config.redact })
  let operations = buildOperations(classified.exchanges, { sourceRoutes })
  operations = inferOperationSchemas(operations, redactor)
  operations = addExtraction(operations, config.build.minExtractSamples)
  operations = addCallSites(operations, resolver)

  const traces = traceValues({
    exchanges: classified.exchanges,
    sessions: loaded.sessions,
    htmlLocator,
    staticStrings,
    minValueLength: config.build.minTraceValueLength,
  })
  const flows = buildFlows({
    exchanges: classified.exchanges,
    operations,
    sessions: loaded.sessions,
    traces,
    sourceResolver: resolver,
    botProtection: classified.botProtection,
    toolVersion: VERSION,
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
    excerpts: new Map(),
    warnings: loaded.warnings,
  }
  if (config.build.excerpts)
    await addExcerpts(analysis, loaded.sessions)
  return analysis
}

/** Runs the whole analysis and writes the handoff folder. `client/` and `probe.json` are kept. */
export async function buildHandoff(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? (() => {})
  const rawDir = resolve(options.cwd, options.config.rawDir)
  const outDir = resolve(options.cwd, options.config.outDir)
  const analysis = await analyze(options.config, rawDir, outDir, log)

  // Remove generated files from a previous build so deleted operations do not linger.
  for (const stale of ['specs', 'source', 'AGENT.md', 'API_MAP.md', 'flows.json', 'flows.md', 'flows.schema.json'])
    await rm(join(outDir, stale), { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const files = [
    ...await writeOpenApiDocuments(outDir, buildOpenApiDocuments(analysis)),
    ...await writeFlows(outDir, analysis.flows, { operations: analysis.operations }),
    ...await writeExcerpts(outDir, analysis.excerpts),
  ]
  const warnings = [...analysis.warnings]
  if (options.config.gen.client && analysis.operations.length > 0) {
    const generated = await generateClient({ handoffDir: outDir, flows: analysis.flows })
    files.push(...generated.files.map(file => join(outDir, file)))
    warnings.push(...generated.warnings)
  }
  files.push(
    ...await writeHandoffDocs(outDir, analysis, {
      toolVersion: VERSION,
      examples: options.config.redact.examples,
      probed: analysis.flows.session.some(entry => entry.probed),
      hasClient: existsSync(join(outDir, 'client', 'index.ts')),
    }),
  )
  log(`Wrote ${files.length} files to ${outDir}`)
  return { analysis, outDir, files, warnings }
}

/** Analysis without writing anything, used by `probe` to get operations and exchanges. */
export async function analyzeCaptures(options: BuildOptions): Promise<Analysis> {
  const rawDir = resolve(options.cwd, options.config.rawDir)
  const outDir = resolve(options.cwd, options.config.outDir)
  return analyze(options.config, rawDir, outDir, options.log ?? (() => {}))
}
