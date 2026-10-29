/**
 * The pipeline commands. Each one only translates flags into config and calls the programmatic
 * API, so the CLI and library behave identically.
 */
import type { Command } from 'commander'
import type { FlowsDocument } from '../model'
import type { CommandRegistrar } from './program'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { InvalidArgumentError } from 'commander'
import { consola } from 'consola'
import { dirname, join, resolve } from 'pathe'
import { analyzeCaptures, buildHandoff, readBuildRecord, recordClientGenerated, stickyOptions } from '../build'
import { runCapture } from '../capture'
import { updateClientState } from '../emit/handoff'
import { SiteToApiError } from '../errors'
import { generateClient } from '../gen'
import { countSessions } from '../load'
import { FlowsDocumentSchema } from '../model'
import { probeOperations, summarizeProbe, writeProbeReport } from '../probe'
import { VERSION } from '../version'
import { resolveConfig } from './program'

function parseNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed))
    throw new InvalidArgumentError(`"${value}" is not a number.`)
  return parsed
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings)
    consola.warn(warning)
}

interface CaptureFlags {
  session?: string
  headless?: boolean
  minimized?: boolean
  channel?: string
  script?: string
  userDataDir?: string
}

const captureCommand: CommandRegistrar = (program) => {
  program
    .command('capture')
    .description('open a browser, record everything while you use the site, then close the browser to finish')
    .argument('[url]', 'page to open first')
    .option('--session <id>', 'session id (default: <host>-<timestamp>)')
    .option('--headless', 'run without a window (for scripted captures; sites with bot protection often block it)')
    .option('--minimized', 'a normal browser with its windows minimized, for scripted captures that should not take over the screen')
    .option('--channel <name>', 'browser channel, e.g. chrome, msedge, or "bundled" for Playwright\'s Chromium')
    .option('--script <file>', 'drive the browser with a script instead of by hand: export default async ({ page, baseUrl }) => {}')
    .option('--user-data-dir <dir>', 'reuse a browser profile so logins persist')
    .action(async (url: string | undefined, flags: CaptureFlags, command: Command) => {
      const { config, cwd } = await resolveConfig(command, {
        capture: {
          browser: {
            headless: flags.headless,
            minimized: flags.minimized,
            channel: flags.channel === 'bundled'
              ? null
              : flags.channel,
            userDataDir: flags.userDataDir,
          },
          script: flags.script
            ? resolve(process.cwd(), flags.script)
            : undefined,
        },
      })
      const controller = new AbortController()
      const result = await runCapture(config, {
        url: url ?? null,
        sessionId: flags.session,
        cwd,
        signal: controller.signal,
        log: message => consola.info(message),
      })
      printWarnings(result.warnings)
      if (result.meta.incomplete) {
        // Saved, but not a clean run: scripts and CI should notice.
        process.exitCode = 1
        consola.warn(`Saved an incomplete capture to ${result.sessionDir}`)
      }
      else {
        consola.success(`Saved capture to ${result.sessionDir}`)
      }
      // Two sessions are what separates constants from per-session values; more help less.
      consola.info(await countSessions(dirname(result.sessionDir)) >= 2
        ? 'Next: `site-to-api build`'
        : 'Next: `site-to-api build` (capture again for a second sample of the same pages first, if you can)')
    })
}

function parseCount(value: string): number {
  const parsed = parseNumber(value)
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new InvalidArgumentError(`"${value}" is not a whole number of 0 or more.`)
  return parsed
}

/** Flags that shape the handoff folder; `build` takes them, and `probe` (which rebuilds) too. */
interface OutputFlags {
  include?: string[]
  exclude?: string[]
  examples?: string
  client?: boolean
}

function addOutputOptions(command: Command, note: string): Command {
  return command
    .option('--include <host>', `only analyse this host (glob, repeatable)${note}`, collect)
    .option('--exclude <host>', `skip this host (glob, repeatable)${note}`, collect)
    .option('--examples <mode>', `masked | raw | none${note}`)
    .option('--no-client', `do not generate the TypeScript client${note}`)
}

function warnIfRaw(examples: string): void {
  if (examples === 'raw')
    consola.warn('redact.examples is "raw": captured values, including personal data, will be written to the handoff folder.')
}

const buildCommand: CommandRegistrar = (program) => {
  addOutputOptions(
    program
      .command('build')
      .description('analyse all captures and write the handoff folder (specs, flows, docs, client); the options used are recorded in build.json for probe and gen'),
    '',
  )
    .action(async (flags: OutputFlags, command: Command) => {
      const { config, cwd, sources } = await resolveConfig(command, {
        hosts: { include: flags.include, exclude: flags.exclude },
        redact: { examples: flags.examples },
        gen: {
          client: flags.client === false
            ? false
            : undefined,
        },
      })
      warnIfRaw(config.redact.examples)
      const result = await buildHandoff({
        config,
        cwd,
        sources,
        log: message => consola.info(message),
      })
      printWarnings(result.warnings)
      consola.success(`${result.analysis.operations.length} operations, ${result.analysis.flows.flows.length} flows → ${result.outDir}`)
      consola.info(`Start with ${resolve(result.outDir, 'AGENT.md')}`)
    })
}

interface ProbeFlags extends OutputFlags {
  maxRps?: number
  unsafeMethods?: boolean
  minimizePerHost?: number
}

const probeCommand: CommandRegistrar = (program) => {
  addOutputOptions(
    program
      .command('probe')
      .description('replay captured requests against the live site to learn what plain HTTP needs (rate limited, safe methods only by default), then rebuild the handoff folder with the options of the last build')
      .option('--max-rps <n>', 'requests per second', parseNumber)
      .option('--unsafe-methods', 'also replay POST, PUT, PATCH and DELETE, GraphQL mutations and GraphQL operations of unknown type (they can change data on the site)')
      .option('--minimize-per-host <n>', 'operations per host whose required cookies and headers are worked out one by one (default 5)', parseCount),
    ' (default: as in the last build)',
  )
    .action(async (flags: ProbeFlags, command: Command) => {
      // The rebuild must look like the last build: `probe` after `build --examples none` must
      // not write masked examples. Flags and SITE_TO_API_* variables given now still win.
      const located = await resolveConfig(command)
      const sticky = stickyOptions(await readBuildRecord(resolve(located.cwd, located.config.outDir)), located.sources)
      const { config, cwd, sources } = await resolveConfig(command, {
        hosts: {
          include: flags.include ?? sticky.hosts.include,
          exclude: flags.exclude ?? sticky.hosts.exclude,
        },
        redact: { examples: flags.examples ?? sticky.redact.examples },
        gen: {
          client: flags.client === false
            ? false
            : sticky.gen.client,
        },
        probe: { maxRps: flags.maxRps, unsafeMethods: flags.unsafeMethods, minimizePerHost: flags.minimizePerHost },
      })
      if (sticky.described.length > 0)
        consola.info(`Using the options of the last build (build.json): ${sticky.described.join(', ')}.`)
      warnIfRaw(config.redact.examples)
      const analysis = await analyzeCaptures({ config, cwd })
      const report = await probeOperations({
        operations: analysis.operations,
        config: config.probe,
        toolVersion: VERSION,
        log: message => consola.info(message),
      })
      const outDir = resolve(cwd, config.outDir)
      await writeProbeReport(outDir, report)
      const result = await buildHandoff({ config, cwd, sources })
      printWarnings(result.warnings)
      for (const line of summarizeProbe(report))
        consola.info(line)
      consola.success(`Handoff folder updated with the probe results: ${outDir}`)
    })
}

async function readFlowsDocument(handoffDir: string): Promise<FlowsDocument> {
  const path = join(handoffDir, 'flows.json')
  if (!existsSync(path))
    throw new SiteToApiError(`${path} not found. Run \`site-to-api build\` first; gen regenerates the client from an existing handoff folder.`)
  let data: unknown
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new SiteToApiError(`${path} is not valid JSON. Run \`site-to-api build\` to rewrite it.`, { cause: error })
  }
  const parsed = FlowsDocumentSchema.safeParse(data)
  if (!parsed.success)
    throw new SiteToApiError(`${path} does not match the flows format of this version. Run \`site-to-api build\` to rewrite it.`)
  return parsed.data
}

const genCommand: CommandRegistrar = (program) => {
  program
    .command('gen')
    .description('regenerate only the TypeScript client from the specs in the handoff folder (updates the client lines of AGENT.md and API_MAP.md)')
    .action(async (_flags: unknown, command: Command) => {
      const { config, cwd } = await resolveConfig(command)
      // Works from the committed handoff folder alone: raw captures are not needed (or present) in a fresh clone.
      const handoffDir = resolve(cwd, config.outDir)
      // Fails on an unreadable build.json before anything in the folder is rewritten.
      await readBuildRecord(handoffDir)
      const result = await generateClient({ handoffDir, flows: await readFlowsDocument(handoffDir) })
      // AGENT.md and API_MAP.md were written when the client was missing or stale; say it exists now.
      printWarnings([
        ...result.warnings,
        ...await updateClientState(handoffDir, 'current'),
      ])
      await recordClientGenerated(handoffDir)
      consola.success(`Generated ${result.files.length} client files`)
    })
}

export const pipelineCommands: CommandRegistrar[] = [
  captureCommand,
  buildCommand,
  probeCommand,
  genCommand,
]
