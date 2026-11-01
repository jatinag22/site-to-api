import type { LoadConfigOptions, LoadedConfig } from '../config/load'
import { statSync } from 'node:fs'
import process from 'node:process'
import { Command } from 'commander'
import { consola } from 'consola'
import { resolve } from 'pathe'
import { loadConfig } from '../config/load'
import { SiteToApiError } from '../errors'
import { VERSION } from '../version'
import { initProject } from './init'

interface GlobalOptions {
  config?: string
  cwd?: string
  rawDir?: string
  outDir?: string
}

interface CommandContext extends LoadedConfig {
  cwd: string
}

/** `--cwd`, checked: a missing folder would otherwise run with defaults as if it were empty. */
function workingDir(options: GlobalOptions): string {
  if (options.cwd === undefined)
    return process.cwd()
  const dir = resolve(process.cwd(), options.cwd)
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true)
    throw new SiteToApiError(`--cwd ${options.cwd}: no such directory (${dir}). Pass the folder of the project to work in.`)
  return dir
}

/** Loads config for a command, layering this command's flags on top. */
export async function resolveConfig(command: Command, flags: Record<string, unknown> = {}, load: Pick<LoadConfigOptions, 'code'> = {}): Promise<CommandContext> {
  const options = command.optsWithGlobals<GlobalOptions>()
  const cwd = workingDir(options)
  const loaded = await loadConfig({
    cwd,
    configFile: options.config ?? null,
    env: process.env,
    flags: { rawDir: options.rawDir, outDir: options.outDir, ...flags },
    ...load,
  })
  return { ...loaded, cwd }
}

function valueAt(root: unknown, path: string): unknown {
  let node = root
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object')
      return undefined
    node = Object.entries(node).find(([name]) => name === key)?.[1]
  }
  return node
}

/** A command module adds itself to the program. */
export type CommandRegistrar = (program: Command) => void

/** The CLI with its built-in commands and `registrars`' commands; `run` parses argv with it. */
export function createProgram(registrars: CommandRegistrar[] = []): Command {
  const program = new Command()
    .name('site-to-api')
    .description('Capture a website\'s traffic once and get OpenAPI specs, request flows and a typed client for coding agents.')
    .version(VERSION)
    .option('-c, --config <file>', 'config file (default: site-to-api.config.{ts,mts,js,mjs,json})')
    .option('--cwd <dir>', 'working directory')
    .option('--raw-dir <dir>', 'raw capture directory (gitignored)')
    .option('--out-dir <dir>', 'handoff output directory')
    .showHelpAfterError()

  program
    .command('init')
    .description('create site-to-api.config.ts and gitignore the raw capture folder')
    .action(async (_options: unknown, command: Command) => {
      const cwd = workingDir(command.optsWithGlobals<GlobalOptions>())
      const result = await initProject(cwd)
      for (const file of result.created)
        consola.success(`Wrote ${file}`)
      for (const file of result.skipped)
        consola.info(`Kept existing ${file}`)
    })

  program
    .command('config')
    .description('print the resolved configuration and where each value came from')
    .option('--json', 'print JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      const { config, file, sources } = await resolveConfig(command)
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ file, config, sources }, null, 2)}\n`)
        return
      }
      consola.info(`Config file: ${file ?? 'none'}`)
      for (const [path, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))
        process.stdout.write(`${path} = ${JSON.stringify(valueAt(config, path))}  (${source})\n`)
    })

  for (const register of registrars)
    register(program)

  return program
}

/** Runs the CLI; user-facing errors print a message and set a non-zero exit code. */
export async function run(argv: string[], registrars: CommandRegistrar[] = []): Promise<void> {
  try {
    await createProgram(registrars).parseAsync(argv)
  }
  catch (error) {
    if (error instanceof SiteToApiError) {
      consola.error(error.message)
      process.exitCode = 1
      return
    }
    throw error
  }
}
