import { describe, expect, it } from 'vitest'
import { loadHeyApi, redirectHookSource, typeScriptVersionForHeyApi } from './hey-api'

interface ResolveResult { url: string, shortCircuit?: boolean }
type Resolve = (specifier: string, context: { parentURL?: string }, next: (specifier: string, context: { parentURL?: string }) => Promise<ResolveResult>) => Promise<ResolveResult>

async function hook(target: string): Promise<Resolve> {
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(redirectHookSource(target))}`)
  if (typeof module !== 'object' || module === null || !('resolve' in module) || typeof module.resolve !== 'function')
    throw new Error('the hook has no resolve function')
  const resolve = module.resolve
  return async (specifier, context, next) => await Reflect.apply(resolve, undefined, [specifier, context, next]) as ResolveResult
}

describe('hey-api loader', () => {
  const next = async (specifier: string): Promise<ResolveResult> => ({ url: `default:${specifier}` })

  it('points typescript imported from a hey-api package at site-to-api\'s own copy', async () => {
    const resolve = await hook('file:///app/node_modules/site-to-api/node_modules/typescript/lib/typescript.js')
    expect(await resolve('typescript', { parentURL: 'file:///app/node_modules/@hey-api/openapi-ts/dist/init.mjs' }, next)).toEqual({
      url: 'file:///app/node_modules/site-to-api/node_modules/typescript/lib/typescript.js',
      format: 'commonjs',
      shortCircuit: true,
    })
  })

  it('leaves every other import alone, including the project\'s own typescript', async () => {
    const resolve = await hook('file:///ours/typescript.js')
    expect(await resolve('typescript', { parentURL: 'file:///app/src/build.mjs' }, next)).toEqual({ url: 'default:typescript' })
    expect(await resolve('zod', { parentURL: 'file:///app/node_modules/@hey-api/openapi-ts/dist/init.mjs' }, next)).toEqual({ url: 'default:zod' })
  })

  it('gives hey-api TypeScript 6 and loads it', async () => {
    expect(typeScriptVersionForHeyApi()).toMatch(/^6\./)
    expect(typeof (await loadHeyApi()).createClient).toBe('function')
  })
})
