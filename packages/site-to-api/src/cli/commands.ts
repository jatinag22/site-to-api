/**
 * The pipeline commands. Each one only translates flags into config and calls the programmatic
 * API, so the CLI and library behave identically.
 */
import type { Command } from 'commander'
import type { CommandRegistrar } from './program'
import process from 'node:process'
import { InvalidArgumentError } from 'commander'
import { consola } from 'consola'
import { resolve } from 'pathe'
import { analyzeCaptures, buildHandoff } from '../build'
import { runCapture } from '../capture'
import { generateClient } from '../gen'
import { probeOperations, writeProbeReport } from '../probe'
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
    .option('--headless', 'run without a window (for scripted captures)')
    .option('--channel <name>', 'browser channel, e.g. chrome, msedge, or "bundled" for Playwright\'s Chromium')
    .option('--script <file>', 'drive the browser with a script instead of by hand: export default async ({ page, baseUrl }) => {}')
    .option('--user-data-dir <dir>', 'reuse a browser profile so logins persist')
    .action(async (url: string | undefined, flags: CaptureFlags, command: Command) => {
      const { config, cwd } = await resolveConfig(command, {
        capture: {
          browser: {
            headless: flags.headless,
            channel: flags.channel === 'bundled' ? null : flags.channel,
            userDataDir: flags.userDataDir,
          },
          script: flags.script ? resolve(process.cwd(), flags.script) : undefined,
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
      consola.success(`Saved capture to ${result.sessionDir}`)
      consola.info('Next: `site-to-api build` (capture again for a second sample of the same pages first, if you can)')
    })
}

interface BuildFlags {
  include?: string[]
  exclude?: string[]
  examples?: string
  client?: boolean
}

const buildCommand: CommandRegistrar = (program) => {
  program
    .command('build')
    .description('analyse all captures and write the handoff folder (specs, flows, docs, client)')
    .option('--include <host>', 'only analyse this host (glob, repeatable)', collect)
    .option('--exclude <host>', 'skip this host (glob, repeatable)', collect)
    .option('--examples <mode>', 'masked | raw | none')
    .option('--no-client', 'do not generate the TypeScript client')
    .action(async (flags: BuildFlags, command: Command) => {
      const { config, cwd } = await resolveConfig(command, {
        hosts: { include: flags.include, exclude: flags.exclude },
        redact: { examples: flags.examples },
        gen: { client: flags.client === false ? false : undefined },
      })
      if (config.redact.examples === 'raw')
        consola.warn('redact.examples is "raw": captured values, including personal data, will be written to the handoff folder.')
      const result = await buildHandoff({ config, cwd, log: message => consola.info(message) })
      printWarnings(result.warnings)
      consola.success(`${result.analysis.operations.length} operations, ${result.analysis.flows.flows.length} flows → ${result.outDir}`)
      consola.info(`Start with ${resolve(result.outDir, 'AGENT.md')}`)
    })
}

interface ProbeFlags {
  maxRps?: number
  unsafeMethods?: boolean
}

const probeCommand: CommandRegistrar = (program) => {
  program
    .command('probe')
    .description('replay captured requests against the live site to learn what plain HTTP needs (rate limited, safe methods only by default)')
    .option('--max-rps <n>', 'requests per second', parseNumber)
    .option('--unsafe-methods', 'also replay POST, PUT, PATCH and DELETE (they can change data on the site)')
    .action(async (flags: ProbeFlags, command: Command) => {
      const { config, cwd } = await resolveConfig(command, {
        probe: { maxRps: flags.maxRps, unsafeMethods: flags.unsafeMethods },
      })
      const analysis = await analyzeCaptures({ config, cwd })
      const report = await probeOperations({
        operations: analysis.operations,
        config: config.probe,
        toolVersion: VERSION,
        log: message => consola.info(message),
      })
      const outDir = resolve(cwd, config.outDir)
      await writeProbeReport(outDir, report)
      for (const entry of report.skipped)
        consola.info(`skipped ${entry.operationId}: ${entry.reason}`)
      const result = await buildHandoff({ config, cwd })
      printWarnings(result.warnings)
      consola.success(`Probed ${report.operations.length} operations; handoff folder updated with the results.`)
    })
}

const genCommand: CommandRegistrar = (program) => {
  program
    .command('gen')
    .description('regenerate only the TypeScript client from the specs in the handoff folder')
    .action(async (_flags: unknown, command: Command) => {
      const { config, cwd } = await resolveConfig(command)
      const analysis = await analyzeCaptures({ config, cwd })
      const result = await generateClient({ handoffDir: resolve(cwd, config.outDir), flows: analysis.flows })
      printWarnings(result.warnings)
      consola.success(`Generated ${result.files.length} client files`)
    })
}

export const pipelineCommands: CommandRegistrar[] = [captureCommand, buildCommand, probeCommand, genCommand]
