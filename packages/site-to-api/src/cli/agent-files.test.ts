/**
 * The agent skill and the Claude Code plugin's commands tell an agent which CLI commands to run.
 * They are Markdown, so nothing else notices when a flag they name is renamed: this test does.
 */
import type { Command } from 'commander'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { pipelineCommands } from './commands'
import { mcpCommand } from './mcp'
import { createProgram } from './program'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const plugin = join(root, 'plugins', 'claude-code')

async function agentFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  files.set('skills/site-to-api/SKILL.md', await readFile(join(root, 'skills', 'site-to-api', 'SKILL.md'), 'utf8'))
  for (const name of await readdir(join(plugin, 'commands')))
    files.set(`plugins/claude-code/commands/${name}`, await readFile(join(plugin, 'commands', name), 'utf8'))
  return files
}

/** The code in Markdown: fenced blocks and inline code spans, where commands are written. */
function code(text: string): string[] {
  const fenced = [
    ...text.matchAll(/^```[^\n]*\n([\s\S]*?)\n```/gm),
  ].map(match => match[1] ?? '')
  const inline = [
    ...text.replace(/^```[\s\S]*?\n```/gm, '').matchAll(/`([^`\n]+)`/g),
  ].map(match => match[1] ?? '')
  return [
    ...fenced,
    ...inline,
  ]
}

/** Every `site-to-api <command> …` invocation in the text's code, with the flags it passes. */
function invocations(text: string): Array<{ command: string, flags: string[] }> {
  return code(text).flatMap(snippet => [
    ...snippet.matchAll(/site-to-api ([a-z]+)([^\n]*)/g),
  ]).map(match => ({
    command: match[1] ?? '',
    flags: [
      ...(match[2] ?? '').matchAll(/(?:^|\s|\[)(--[a-z][a-z-]*)/g),
    ].map(flag => flag[1] ?? ''),
  }))
}

function optionNames(command: Command): string[] {
  return command.options.flatMap(option => [
    option.long,
    option.negate
      ? option.long?.replace(/^--no-/, '--')
      : undefined,
  ]).filter(name => name !== undefined)
}

describe('agent skill and plugin commands', () => {
  it('ship the same skill to Claude Code and to other agents', async () => {
    expect(await readFile(join(plugin, 'skills', 'site-to-api', 'SKILL.md'), 'utf8'))
      .toBe(await readFile(join(root, 'skills', 'site-to-api', 'SKILL.md'), 'utf8'))
  })

  it('start the plugin\'s server on ./api-handoff, read-only, trusting no client', async () => {
    const config = z.object({
      mcpServers: z.record(z.string(), z.object({
        command: z.string(),
        args: z.array(z.string()),
      })),
    })
      .parse(JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8')))
    // The globally installed binary from PATH, never a bin the opened project supplies (`npx`
    // would run a committed node_modules/.bin or a package named site-to-api): Claude Code starts
    // the server in every project, untrusted clones included.
    expect(config.mcpServers['site-to-api']).toEqual({
      command: 'site-to-api',
      args: [
        '--cwd',
        // Claude Code substitutes the variable; the file holds it literally.
        ['$', '{CLAUDE_PROJECT_DIR}'].join(''),
        'mcp',
        './api-handoff',
      ],
    })
  })

  it('pre-approve no command, since the CLI runs the project\'s config file', async () => {
    for (const [file, text] of await agentFiles())
      expect(text, file).not.toMatch(/^allowed-tools:/m)
  })

  it('name only commands and flags the CLI has', async () => {
    const program = createProgram([...pipelineCommands, mcpCommand])
    const global = optionNames(program)
    const checked: string[] = []
    for (const [file, text] of await agentFiles()) {
      for (const { command, flags } of invocations(text)) {
        const found = program.commands.find(candidate => candidate.name() === command)
        expect(found, `${file}: site-to-api ${command}`).toBeDefined()
        for (const flag of flags) {
          expect([
            ...global,
            ...optionNames(found ?? program),
          ], `${file}: site-to-api ${command} ${flag}`).toContain(flag)
          checked.push(`${command} ${flag}`)
        }
      }
    }
    expect(checked).toEqual(expect.arrayContaining([
      'capture --channel',
      'capture --minimized',
      'mcp --allow-calls',
      'gen --mcp',
      'check --json',
    ]))
  })
})
