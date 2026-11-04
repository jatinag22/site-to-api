import process from 'node:process'
import { pipelineCommands } from './commands'
import { mcpCommand } from './mcp'
import { allowSlowConnects } from './network'
import { run } from './program'

// `site-to-api config | head` closes the pipe early; that is a normal way to end, not a crash.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE')
    process.exit(0)
  throw error
})

allowSlowConnects()

void run(process.argv, [...pipelineCommands, mcpCommand])
