/**
 * Runs the Pinewood Market fixture site until stopped, for trying site-to-api by hand:
 *   pnpm --filter @site-to-api/e2e run fixture
 */
import process from 'node:process'
import { startFixtureSite } from './server'

const port = Number(process.env.PORT ?? 4173)

startFixtureSite({ port }).then((site) => {
  process.stdout.write(`Pinewood Market: ${site.origin}  (analytics host: ${site.secondaryOrigin})\nPress Ctrl+C to stop.\n`)
  const stop = (): void => {
    void site.close().then(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}, (error: unknown) => {
  process.stderr.write(`Could not start the fixture site: ${error instanceof Error
    ? error.message
    : String(error)}\n`)
  process.exit(1)
})
