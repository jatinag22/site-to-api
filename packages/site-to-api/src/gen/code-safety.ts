/**
 * Keeps site-controlled spec text out of the code hey-api writes (decision 0043). hey-api writes
 * some spec values into code without escaping them: a `pattern` becomes a regular expression
 * literal, and it even decodes `\x2f` and `/` into `/` while doing so, so a pattern such as
 * `a\x2f, globalThis.x=1, \x2fb` became running code. Rather than chase each encoding, hey-api
 * gets a copy of the spec without the fields a working client does not need, and its output is
 * checked afterwards.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { SiteToApiError } from '../errors'

/**
 * Keywords removed from hey-api's input. `pattern` (regex literals), documentation (JSDoc
 * comments) and examples: none of them changes what the client sends or accepts, except that the
 * client no longer checks patterns. `x-` extensions are site-to-api's own and read from the
 * original spec.
 */
const DROPPED: ReadonlySet<string> = new Set([
  'pattern',
  'description',
  'title',
  'summary',
  'example',
  'examples',
  'externalDocs',
])

/**
 * The document hey-api generates from: `document` without the {@link DROPPED} keywords and
 * extensions. Keys of a `properties` map are field names, not keywords, so a field called
 * `description` stays. Response objects keep an empty `description`, which OpenAPI requires.
 */
export function heyApiInput(document: unknown): unknown {
  return walkInput(document, 'schema')
}

/** Where a value sits: a keyword object, a `properties` map, or a `responses` map. */
type InputContext = 'schema' | 'properties' | 'responses'

/** The context of the value under `key`. Field names in a `properties` map are not keywords. */
function contextOf(context: InputContext, key: string): InputContext {
  if (context === 'properties')
    return 'schema'
  if (key === 'properties' || key === 'patternProperties')
    return 'properties'
  return key === 'responses'
    ? 'responses'
    : 'schema'
}

function walkInput(value: unknown, context: InputContext): unknown {
  if (Array.isArray(value))
    return value.map(item => walkInput(item, 'schema'))
  if (typeof value !== 'object' || value === null)
    return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (context !== 'properties' && (DROPPED.has(key) || key.startsWith('x-')))
      continue
    const walked = walkInput(child, contextOf(context, key))
    // Each entry of a `responses` map is a Response object, which must have a description.
    result[key] = context === 'responses' && typeof walked === 'object' && walked !== null && !Array.isArray(walked)
      ? { ...walked, description: '' }
      : walked
  }
  return result
}

/**
 * The regular expression literals hey-api 0.99's own runtime files carry (`core/`), which no
 * spec value reaches. Any other regex literal in the output means spec text became code. A
 * hey-api upgrade that changes them fails `gen` until this list is updated (decision 0010).
 */
const TEMPLATE_REGEXES: ReadonlySet<string> = new Set([
  '/\\r\\n?/g',
  '/^data:\\s*/',
  '/^event:\\s*/',
  '/^id:\\s*/',
  '/^retry:\\s*/',
  '/\\{[^{}]+\\}/g',
])

async function typeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => path.join(entry.parentPath, entry.name)).sort()
}

function regexLiterals(source: ts.SourceFile): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral)
      found.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function syntaxErrors(file: string, source: ts.SourceFile): readonly ts.Diagnostic[] {
  // A one-file program reports exactly the syntax errors of that file.
  const program = ts.createProgram({
    rootNames: [file],
    options: { noResolve: true, noLib: true, types: [] },
    host: {
      ...ts.createCompilerHost({}),
      getSourceFile: name => name === file
        ? source
        : undefined,
      fileExists: name => name === file,
      writeFile: () => {},
    },
  })
  return program.getSyntacticDiagnostics(source)
}

/**
 * Fails when a generated file under `clientDir` (hey-api's and site-to-api's own) does not parse,
 * or has a regular expression literal other than hey-api's template ones in its `core/` folder:
 * either means a spec value changed the code. Nothing in `client/` should be used then.
 */
export async function checkGeneratedCode(clientDir: string, label = 'client'): Promise<void> {
  for (const file of await typeScriptFiles(clientDir)) {
    const relative = path.relative(clientDir, file).split(path.sep).join('/')
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
    const [error] = syntaxErrors(file, source)
    if (error !== undefined)
      throw new SiteToApiError(`Generated ${label}/${relative} does not parse (${ts.flattenDiagnosticMessageText(error.messageText, ' ')}): a spec value broke the code. Do not use ${label}/; report the spec that caused it.`)
    const inCore = /^[^/]+\/core\//.test(relative)
    const stray = regexLiterals(source).find(literal => !inCore || !TEMPLATE_REGEXES.has(literal))
    if (stray !== undefined)
      throw new SiteToApiError(`Generated ${label}/${relative} has the regular expression ${stray.slice(0, 80)}, which no generated file should have: a spec value became code. Do not use ${label}/; report the spec that caused it.`)
  }
}
