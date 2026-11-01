/**
 * `site-to-api mcp`: serves the handoff folder to an MCP client over stdio (decision 0043).
 * Translates flags into options and calls `serveHandoff`; stdout carries the protocol, so
 * messages go to stderr.
 */
import type { Command } from 'commander'
import type { CommandRegistrar } from './program'
import process from 'node:process'
import { InvalidArgumentError } from 'commander'
import { resolve } from 'pathe'
import { staticConfigValue } from '../config/static'
import { serveGenerated, serveHandoff } from '../mcp'
import { resolveConfig } from './program'

interface McpFlags {
  allowCalls?: boolean
  unsafeMethods?: boolean
  maxRps?: number
  trustClient?: boolean
  generated?: boolean
}

/** Credentials and settings the callers read; nothing else of the environment is handed on. */
function siteApiEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('SITE_API_')))
}

function parseRate(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10)
    throw new InvalidArgumentError(`"${value}" is not a rate between 0 and 10 requests per second.`)
  return parsed
}

export const mcpCommand: CommandRegistrar = (program) => {
  program
    .command('mcp')
    .description('serve the handoff folder to an AI agent as an MCP server over stdio: read-only tools to search operations, flows, examples and source; never reads the raw captures')
    .argument('[dir]', 'handoff folder (default: outDir from the config)')
    .option('--allow-calls', 'add call_operation, which sends requests to the live site through the generated client (safe methods only, rate limited)')
    .option('--unsafe-methods', 'with --allow-calls: also send POST, PUT, PATCH, DELETE and GraphQL mutations (they can change data on the site)')
    .option('--max-rps <n>', 'requests per second for call_operation (default: probe.maxRps, 1)', parseRate)
    .option('--trust-client', 'run the folder\'s client/ code even though this machine did not generate it (only after reviewing it)')
    .option('--generated', 'serve client/mcp/server.ts (written by `gen --mcp`) instead of the exploration tools, after the same trust check')
    .action(async (dir: string | undefined, flags: McpFlags, command: Command) => {
      const log = (message: string): void => {
        process.stderr.write(`${message}\n`)
      }
      // A plugin starts this command in every project: a .ts or .js config file is code from the
      // project, so only flags, SITE_TO_API_* variables and site-to-api.config.json are read.
      const { config, cwd, ignored, sources } = await resolveConfig(command, {
        probe: { maxRps: flags.maxRps },
      }, { code: false })
      let outDir = config.outDir
      if (ignored !== undefined && dir === undefined && sources.outDir === 'default') {
        // The file is not run, but a plain `outDir: '…'` in it can be read (decision 0057).
        const read = await staticConfigValue(ignored, 'outDir')
        if (read !== null)
          outDir = read
        else
          log(`Not running ${ignored} and found no plain \`outDir: '…'\` in it, so the handoff folder is ${outDir}. Pass the folder instead: \`site-to-api mcp <outDir>\`.`)
      }
      const handoffDir = resolve(cwd, dir ?? outDir)
      if (flags.generated) {
        await serveGenerated({ handoffDir, trustClient: flags.trustClient === true })
        return
      }
      if (flags.unsafeMethods && !flags.allowCalls)
        log('--unsafe-methods has no effect without --allow-calls.')
      await serveHandoff({
        handoffDir,
        allowCalls: flags.allowCalls === true,
        unsafeMethods: flags.allowCalls === true && flags.unsafeMethods === true,
        maxRps: config.probe.maxRps,
        timeoutMs: config.probe.timeoutMs,
        env: siteApiEnv(process.env),
        trustClient: flags.trustClient === true,
        log,
      })
    })
}
