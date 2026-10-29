/**
 * `check`: replay safe requests against the live site and compare the answers with the specs
 * (decision 0044). Exit code 0 no drift, 1 drift, 2 an error or nothing could be checked.
 */
import type { Command } from 'commander'
import type { CommandRegistrar } from './program'
import process from 'node:process'
import { InvalidArgumentError } from 'commander'
import { consola } from 'consola'
import { resolve } from 'pathe'
import { analyzeForProbe, readBuildRecord, stickyOptions } from '../build'
import { checkOperations, selectOperations, summarizeCheck, volatileInputs, writeCheckReport } from '../check'
import { VERSION } from '../version'
import { resolveConfig } from './program'

interface CheckFlags {
  include?: string[]
  exclude?: string[]
  operations?: string[]
  maxRps?: number
  json?: boolean
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function parseRate(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed))
    throw new InvalidArgumentError(`"${value}" is not a number.`)
  return parsed
}

async function runCheck(flags: CheckFlags, command: Command): Promise<void> {
  // The schemas to compare with are those of the last build: its sticky options apply.
  const located = await resolveConfig(command)
  const sticky = stickyOptions(await readBuildRecord(resolve(located.cwd, located.config.outDir)), located.sources)
  const { config, cwd } = await resolveConfig(command, {
    hosts: sticky.hosts,
    redact: { examples: sticky.redact.examples },
    probe: { maxRps: flags.maxRps },
  })
  const { analysis, redactText } = await analyzeForProbe({ config, cwd })
  const operationIds = flags.operations?.flatMap(value => value.split(',')).map(id => id.trim()).filter(id => id !== '')
  // Only the site's own hosts by default; a third party is opted in with --include.
  const { operations, skippedHosts } = selectOperations(analysis, { include: flags.include, exclude: flags.exclude, operationIds })
  const report = await checkOperations({
    operations,
    skippedHosts,
    staleInputs: volatileInputs(analysis),
    config: config.probe,
    toolVersion: VERSION,
    operationIds,
    redactText,
    log: flags.json
      ? undefined
      : message => consola.info(message),
  })
  await writeCheckReport(resolve(cwd, config.outDir), report)
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  else {
    for (const line of summarizeCheck(report))
      process.stdout.write(`${line}\n`)
  }
  process.exitCode = report.exitCode
}

const checkCommand: CommandRegistrar = (program) => {
  program
    .command('check')
    .description('replay safe requests against the live site and compare each answer with its response schema, to detect API drift; writes check.json. Exit code 0 no drift, 1 drift, 2 error')
    .option('--include <host>', 'check these hosts, third-party ones too (glob, repeatable); by default only the site\'s own hosts are checked', collect)
    .option('--exclude <host>', 'skip this host (glob, repeatable)', collect)
    .option('--operations <ids>', 'only these operation ids (comma separated, repeatable)', collect)
    .option('--max-rps <n>', 'requests per second', parseRate)
    .option('--json', 'print check.json to stdout instead of the summary')
    // Commander exits 1 on a usage error (an unknown flag, `--max-rps abc`), which would read as
    // drift. Its message is already printed; only the code changes. Help and version stay 0.
    .exitOverride((error) => {
      process.exit(error.exitCode === 0
        ? 0
        : 2)
    })
    .action(async (flags: CheckFlags, command: Command) => {
      try {
        await runCheck(flags, command)
      }
      catch (error) {
        // Exit 1 means drift, so a failure to check must not look like it.
        consola.error(error instanceof Error
          ? error.message
          : String(error))
        process.exitCode = 2
      }
    })
}

export const checkCommands: CommandRegistrar[] = [checkCommand]
