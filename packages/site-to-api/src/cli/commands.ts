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
import { InvalidArgumentError, Option } from 'commander'
import { consola } from 'consola'
import { dirname, join, resolve } from 'pathe'
import { analyzeForProbe, buildHandoff, configuredClientDir, configuredMcpDir, previousClient, previousMcp, readBuildRecord, recordClientGenerated, recordedClientDir, recordedMcpDir, relativePath, stickyOptions } from '../build'
import { CHANNEL_NAMES, channelList, normalizeCaptureUrl, runCapture } from '../capture'
import { updateClientState } from '../emit/handoff'
import { SiteToApiError } from '../errors'
import { generateClient } from '../gen'
import { importHar } from '../import'
import { countSessions } from '../load'
import { FlowsDocumentSchema } from '../model'
import { probeOperations, summarizeProbe, unreachableWarning, writeProbeReport } from '../probe'
import { VERSION } from '../version'
import { checkCommands } from './check'
import { counted, shown, warn } from './output'
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
    warn(warning)
}

function parseChannel(value: string): string {
  if (!CHANNEL_NAMES.includes(value))
    throw new InvalidArgumentError(`"${value}" is not a browser capture can use. Capture records with Chromium-based browsers: ${channelList()}.`)
  return value
}

/** Without a script nobody can use a headless browser, and the capture would never end. */
function headlessWithoutScript(source: string | undefined): string {
  const where = source === 'flag'
    ? '--headless'
    : `capture.browser.headless (set in ${source === 'env'
      ? 'SITE_TO_API_CAPTURE__BROWSER__HEADLESS'
      : 'the config file'})`
  return `${where} needs a capture script: a headless browser has no window to use the site in. Add --script <file> to drive it with a script, or drop --headless to use the site by hand (--minimized keeps a scripted capture off the screen).`
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
    .option('--channel <name>', `browser: ${channelList()} (default: chrome, or bundled where Chrome is not installed)`, parseChannel)
    .option('--script <file>', 'drive the browser with a script instead of by hand: export default async ({ page, baseUrl }) => {}')
    .option('--user-data-dir <dir>', 'reuse a browser profile so logins persist')
    .action(async (url: string | undefined, flags: CaptureFlags, command: Command) => {
      const startUrl = url === undefined
        ? null
        : normalizeCaptureUrl(url)
      const { config, cwd, sources } = await resolveConfig(command, {
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
      if (config.capture.browser.headless && config.capture.script === null)
        throw new SiteToApiError(headlessWithoutScript(sources['capture.browser.headless']))
      const controller = new AbortController()
      const result = await runCapture(config, {
        url: startUrl,
        sessionId: flags.session,
        cwd,
        signal: controller.signal,
        channelFallback: sources['capture.browser.channel'] === 'default',
        instructions: process.stdin.isTTY === true,
        log: message => consola.info(message),
      })
      printWarnings(result.warnings)
      const contents = [
        result.requests === null
          ? 'no readable HAR'
          : counted(result.requests, 'request'),
        counted(result.events, 'event'),
        counted(result.meta.scripts.length, 'script'),
      ].join(', ')
      if (result.meta.incomplete) {
        // Saved, but not a clean run: scripts and CI should notice.
        process.exitCode = 1
        warn(`Saved an incomplete session ${result.meta.sessionId} to ${shown(result.sessionDir)} (${contents}).`)
      }
      else {
        consola.success(`Saved session ${result.meta.sessionId} to ${shown(result.sessionDir)} (${contents}).`)
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
  mcp?: string
}

const MCP_HELP = 'also write mcp/ next to the client (gen.mcpDir), an MCP server with a tool per operation: read (the default: operations that only read) | write (all) | off'

/** `--mcp [mode]`; `--mcp` alone means `read`. */
function mcpOption(note: string): Option {
  return new Option('--mcp [mode]', `${MCP_HELP}${note}`).preset('read').argParser(mcpMode)
}

function addOutputOptions(command: Command, note: string): Command {
  return command
    .option('--include <host>', `only analyse this host (glob, repeatable)${note}`, collect)
    .option('--exclude <host>', `skip this host (glob, repeatable)${note}`, collect)
    .option('--examples <mode>', `example values in the handoff folder${note}:\nmasked: secrets and personal data replaced (default)\nraw: captured values as they are, personal data too\nnone: no example values`, examplesMode)
    .option('--no-client', `do not generate the TypeScript client${note}`)
    .addOption(mcpOption(note))
}

function examplesMode(value: string): string {
  if (!['masked', 'raw', 'none'].includes(value))
    throw new InvalidArgumentError(`"${value}" is not an examples mode: use masked, raw or none.`)
  return value
}

function mcpMode(value: string): string {
  if (!['off', 'read', 'write'].includes(value))
    throw new InvalidArgumentError(`"${value}" is not an MCP mode: use read, write or off.`)
  return value
}

function warnIfRaw(examples: string): void {
  if (examples === 'raw')
    warn('redact.examples is "raw": captured values, including personal data, will be written to the handoff folder.')
}

const buildCommand: CommandRegistrar = (program) => {
  addOutputOptions(
    program
      .command('build')
      .description('analyse all captures and write the handoff folder (specs, flows, docs, client); the options used are recorded in build.json for probe and gen'),
    '',
  )
    .option('--force', 'overwrite generated client files you edited by hand (they are kept and reported otherwise)')
    .action(async (flags: OutputFlags & { force?: boolean }, command: Command) => {
      const { config, cwd, sources } = await resolveConfig(command, {
        hosts: { include: flags.include, exclude: flags.exclude },
        redact: { examples: flags.examples },
        gen: {
          client: flags.client === false
            ? false
            : undefined,
          mcp: flags.mcp,
        },
      })
      warnIfRaw(config.redact.examples)
      const result = await buildHandoff({
        config,
        cwd,
        sources,
        force: flags.force === true,
        log: message => consola.info(message),
      })
      printWarnings(result.warnings)
      consola.success(`${counted(result.analysis.operations.length, 'operation')}, ${counted(result.analysis.flows.flows.length, 'flow')} → ${shown(result.outDir)}`)
      consola.info(`Start with ${shown(resolve(result.outDir, 'AGENT.md'))}`)
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
          mcp: flags.mcp ?? sticky.gen.mcp,
        },
        probe: { maxRps: flags.maxRps, unsafeMethods: flags.unsafeMethods, minimizePerHost: flags.minimizePerHost },
      })
      if (sticky.described.length > 0)
        consola.info(`Using the options of the last build (build.json): ${sticky.described.join(', ')}.`)
      warnIfRaw(config.redact.examples)
      const { analysis, captured, redactProbeReport } = await analyzeForProbe({ config, cwd })
      const report = await probeOperations({
        operations: analysis.operations,
        config: config.probe,
        toolVersion: VERSION,
        log: message => consola.info(message),
      })
      const outDir = resolve(cwd, config.outDir)
      // probe.json lives in the handoff folder: names that carry values are redacted here, not
      // only by the rebuild below, which may fail.
      await writeProbeReport(outDir, redactProbeReport(report))
      // The captures were analysed above: the rebuild only applies the new probe.json.
      const result = await buildHandoff({ config, cwd, sources, captured })
      printWarnings(result.warnings)
      for (const line of summarizeProbe(report))
        consola.info(line)
      const unreachable = unreachableWarning(report)
      if (unreachable !== null) {
        // Nothing was learnt: scripts and CI should not take this run as a probe.
        warn(unreachable)
        process.exitCode = 1
        return
      }
      consola.success(`Handoff folder updated with the probe results: ${shown(outDir)}`)
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
    .addOption(mcpOption(''))
    .option('--force', 'overwrite generated client files you edited by hand (they are kept and reported otherwise)')
    .action(async (flags: { mcp?: string, force?: boolean }, command: Command) => {
      const { config, cwd, sources } = await resolveConfig(command, {
        gen: { mcp: flags.mcp },
      })
      // Works from the committed handoff folder alone: raw captures are not needed (or present) in a fresh clone.
      const handoffDir = resolve(cwd, config.outDir)
      // Fails on an unreadable build.json before anything in the folder is rewritten.
      const record = await readBuildRecord(handoffDir)
      // The configured folder when one is set; otherwise the one the last build used (decision 0058).
      const clientDir = sources['gen.clientDir'] === 'default'
        ? recordedClientDir(handoffDir, record)
        : configuredClientDir(config, cwd)
      const mcpDir = sources['gen.mcpDir'] === 'default' && sources['gen.clientDir'] === 'default'
        ? recordedMcpDir(handoffDir, record)
        : configuredMcpDir(config, cwd)
      const { previous, warning } = previousClient(handoffDir, record, clientDir)
      const result = await generateClient({
        handoffDir,
        clientDir,
        mcpDir,
        root: cwd,
        flows: await readFlowsDocument(handoffDir),
        mcp: config.gen.mcp,
        previous,
        previousMcp: previousMcp(handoffDir, record, mcpDir),
        force: flags.force === true,
      })
      const clientPath = relativePath(handoffDir, clientDir)
      // AGENT.md and API_MAP.md were written when the client was missing or stale; say it exists now.
      printWarnings([
        ...(warning === null
          ? []
          : [warning]),
        ...result.warnings,
        ...await updateClientState(handoffDir, result.empty
          ? 'empty'
          : 'current', clientPath),
      ])
      await recordClientGenerated(handoffDir, {
        mcp: { mode: config.gen.mcp, sticky: sources['gen.mcp'] === 'flag' || sources['gen.mcp'] === 'env' },
        generated: result.manifest,
        generatedMcp: result.mcpManifest,
        clientDir: clientPath,
        mcpDir: relativePath(handoffDir, mcpDir),
      })
      consola.success(`Generated ${counted(result.files.length, 'client file')} in ${shown(clientDir, cwd)}`)
    })
}

interface ImportFlags {
  session?: string
  deleteSource?: boolean
}

const importCommand: CommandRegistrar = (program) => {
  program
    .command('import')
    .description('turn a HAR file exported from browser DevTools or a proxy into a raw session that build, probe and gen use like a captured one')
    .argument('<file>', 'the .har file')
    .option('--session <id>', 'session id (default: <host>-<timestamp> of the first page)')
    .option('--delete-source', 'delete the HAR file after importing it (it holds your cookies)')
    .action(async (file: string, flags: ImportFlags, command: Command) => {
      const { config, cwd } = await resolveConfig(command)
      const result = await importHar(config, {
        file: resolve(process.cwd(), file),
        sessionId: flags.session,
        cwd,
        deleteSource: flags.deleteSource,
      })
      printWarnings(result.warnings)
      consola.success(`Imported session ${result.meta.sessionId} to ${shown(result.sessionDir)} (${counted(result.entries, 'request')}, ${counted(result.events, 'event')}, ${counted(result.scripts, 'script')}).`)
      if (result.sourceDeleted)
        consola.info(`Deleted ${file}.`)
      else
        warn(`${file} holds your cookies and session tokens. Delete it once you no longer need it (or import with --delete-source).`)
      consola.info('Next: `site-to-api build`. A HAR has no record of what the page\'s code did, so AGENT.md lists what an imported session cannot show.')
    })
}

export const pipelineCommands: CommandRegistrar[] = [
  captureCommand,
  importCommand,
  buildCommand,
  probeCommand,
  genCommand,
  ...checkCommands,
]
