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
import { serveHandoff } from '../mcp'
import { resolveConfig } from './program'

interface McpFlags {
  allowCalls?: boolean
  unsafeMethods?: boolean
  maxRps?: number
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
    .action(async (dir: string | undefined, flags: McpFlags, command: Command) => {
      const { config, cwd } = await resolveConfig(command, {
        probe: { maxRps: flags.maxRps },
      })
      const log = (message: string): void => {
        process.stderr.write(`${message}\n`)
      }
      if (flags.unsafeMethods && !flags.allowCalls)
        log('--unsafe-methods has no effect without --allow-calls.')
      await serveHandoff({
        handoffDir: resolve(cwd, dir ?? config.outDir),
        allowCalls: flags.allowCalls === true,
        unsafeMethods: flags.allowCalls === true && flags.unsafeMethods === true,
        maxRps: config.probe.maxRps,
        timeoutMs: config.probe.timeoutMs,
        env: process.env,
        log,
      })
    })
}
