/**
 * Bundles the frontend in `app/src/` with esbuild when the site starts, in the three forms the
 * tool's source stage must handle:
 * - `/assets/app.<hash>.js`: the main bundle, whitespace-minified (one long line, so column
 *   mapping matters) with an external sourcemap that embeds `sourcesContent`;
 * - `/assets/ticker.js`: the WebSocket widget with an inline `data:` sourcemap;
 * - `/shield/sensor.js`: the toy bot-protection script, fully minified with no sourcemap.
 * Nothing is written to disk.
 */
import type { StaticFile } from './static'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), 'app')

export interface FrontendBundle {
  /** URL path of the main bundle, e.g. `/assets/app.4F2KQ7ZB.js`. */
  appScript: string
  /** Every built file keyed by URL path. */
  files: Map<string, StaticFile>
}

const JS = 'text/javascript; charset=utf-8'

/** Builds all frontend scripts. Output is deterministic for the same sources. */
export async function buildFrontend(): Promise<FrontendBundle> {
  const files = new Map<string, StaticFile>()
  const common = {
    absWorkingDir: APP_DIR,
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    // Source paths in the maps become `src/...`, relative to this directory.
    outdir: APP_DIR,
    logLevel: 'silent',
  } as const

  const app = await build({
    ...common,
    entryPoints: ['src/main.ts'],
    entryNames: 'app.[hash]',
    sourcemap: 'linked',
    sourcesContent: true,
    minifyWhitespace: true,
    minifySyntax: true,
  })
  let appScript = ''
  for (const file of app.outputFiles) {
    const path = `/assets/${basename(file.path)}`
    if (path.endsWith('.js')) {
      appScript = path
      files.set(path, { contentType: JS, body: file.contents })
    }
    else {
      files.set(path, { contentType: 'application/json; charset=utf-8', body: file.contents })
    }
  }
  if (appScript === '')
    throw new Error('esbuild produced no app bundle')

  const ticker = await build({
    ...common,
    entryPoints: ['src/widgets/ticker.ts'],
    entryNames: 'ticker',
    sourcemap: 'inline',
    sourcesContent: true,
  })
  const sensor = await build({
    ...common,
    entryPoints: ['src/shield/sensor.ts'],
    entryNames: 'sensor',
    sourcemap: false,
    minify: true,
  })
  files.set('/assets/ticker.js', {
    contentType: JS,
    body: onlyOutput(ticker.outputFiles),
  })
  files.set('/shield/sensor.js', {
    contentType: JS,
    body: onlyOutput(sensor.outputFiles),
  })

  return { appScript, files }
}

function onlyOutput(outputs: Array<{ contents: Uint8Array }>): Uint8Array {
  const [first] = outputs
  if (first === undefined || outputs.length !== 1)
    throw new Error(`expected one esbuild output, got ${outputs.length}`)
  return first.contents
}
