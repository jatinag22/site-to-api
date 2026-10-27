import process from 'node:process'
import { pipelineCommands } from './commands'
import { run } from './program'

await run(process.argv, pipelineCommands)
