#!/usr/bin/env node
// Checks that a module runs outside Node (Bun, Deno, edge workers): bundled with esbuild for
// `platform=neutral`, it must import no `node:` module or Node builtin and use no Node global
// (`process`, `Buffer`, `global`, `__dirname`, `__filename`, `require`, `setImmediate`). Used by
// scripts/smoke-package.mjs on the packed runtime; also runnable on its own.
//
// Usage: node scripts/check-neutral.mjs <entry.mjs>
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')

/** Node globals, each replaced by a marker that must not survive into the bundle. */
const NODE_GLOBALS = [
  'process',
  'Buffer',
  'global',
  '__dirname',
  '__filename',
  'require',
  'setImmediate',
  'clearImmediate',
]

/**
 * The problems found when bundling `entry` for a neutral platform: unresolvable imports (Node
 * builtins do not resolve there) and Node globals the code reads. Empty when it is neutral.
 */
export async function neutralProblems(entry) {
  const esbuild = createRequire(join(root, 'e2e', 'package.json'))('esbuild')
  const define = Object.fromEntries(NODE_GLOBALS.flatMap(name => [
    [name, `__NODE_GLOBAL__${name}`],
    [`globalThis.${name}`, `__NODE_GLOBAL__${name}`],
  ]))
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    define,
    write: false,
    logLevel: 'silent',
  }).catch(error => error)
  if (result instanceof Error) {
    return (result.errors ?? [
      { text: result.message },
    ]).map(item => `does not bundle: ${item.text}`)
  }
  const text = result.outputFiles.map(file => file.text).join('\n')
  const problems = []
  for (const match of text.matchAll(/["'](node:[\w/]+)["']/g))
    problems.push(`imports ${match[1]}`)
  for (const match of text.matchAll(/__NODE_GLOBAL__(\w+)/g))
    problems.push(`uses the Node global ${match[1]}`)
  return [
    ...new Set(problems),
  ]
}

if (process.argv[1] === import.meta.filename) {
  const entry = process.argv[2]
  if (entry === undefined) {
    console.error('usage: node scripts/check-neutral.mjs <entry.mjs>')
    process.exit(2)
  }
  const problems = await neutralProblems(resolve(entry))
  if (problems.length > 0) {
    console.error(`check-neutral: ${entry} is not neutral:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`check-neutral: ${entry} bundles for platform=neutral with no Node imports or globals`)
}
