/**
 * Spec `pattern`s are site-controlled text that hey-api writes into `zod.gen.ts` as regular
 * expression literals without escaping them (decision 0043, a known hey-api issue): `*x` opens a
 * block comment, `a\\/b` ends the literal early, and validation silently disappears from a client
 * the trust gate then trusts. Patterns that could do that are dropped before generation (a
 * looser schema, never broken code), and the generated files are parsed afterwards to prove it.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { SiteToApiError } from '../errors'

/** Why a pattern cannot be written as a regex literal safely, or null when it can. */
export function unsafePattern(pattern: string): string | null {
  if (pattern.startsWith('*'))
    return 'it starts with `*`, which would open a comment'
  if (pattern.includes('/'))
    return 'it contains `/`, which would end the regular expression literal'
  if (/[\n\r\u2028\u2029]/.test(pattern))
    return 'it contains a line break'
  try {
    // eslint-disable-next-line no-new -- compiling is the check
    new RegExp(pattern)
  }
  catch {
    return 'it is not a valid regular expression'
  }
  return null
}

/**
 * A copy of `document` without unsafe `pattern` keywords, and the patterns kept. Keys of a
 * `properties` map are field names, not keywords, and `x-` extensions are not schemas.
 */
export function withSafePatterns(document: unknown, where: string, warnings: string[]): { document: unknown, patterns: Set<string> } {
  const patterns = new Set<string>()
  const walk = (value: unknown, propertyMap: boolean): unknown => {
    if (Array.isArray(value))
      return value.map(item => walk(item, false))
    if (typeof value !== 'object' || value === null)
      return value
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (!propertyMap && key.startsWith('x-')) {
        result[key] = child
        continue
      }
      if (!propertyMap && key === 'pattern' && typeof child === 'string') {
        const reason = unsafePattern(child)
        if (reason === null) {
          patterns.add(child)
          result[key] = child
        }
        else {
          warnings.push(`${where}: dropped the pattern ${JSON.stringify(child.slice(0, 80))} because ${reason}; the generated schema accepts any string there`)
        }
        continue
      }
      result[key] = walk(child, !propertyMap && (key === 'properties' || key === 'patternProperties'))
    }
    return result
  }
  return {
    document: walk(document, false),
    patterns,
  }
}

async function typeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => path.join(entry.parentPath, entry.name)).sort()
}

/** The bodies of the regular expression literals in `source` (`/a+/g` → `a+`). */
function regexLiterals(source: ts.SourceFile): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = node.getText(source)
      found.push(text.slice(1, text.lastIndexOf('/')))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * Fails when a generated file does not parse, or when a `zod.gen.ts` has a regular expression
 * that is not one of the spec's kept patterns: either means site text changed the code.
 */
export async function checkGeneratedCode(dir: string, patterns: ReadonlySet<string>): Promise<void> {
  for (const file of await typeScriptFiles(dir)) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
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
    const errors = program.getSyntacticDiagnostics(source)
    if (errors.length > 0)
      throw new SiteToApiError(`Generated ${path.relative(dir, file)} does not parse (${ts.flattenDiagnosticMessageText(errors[0]?.messageText ?? '', ' ')}); a spec value broke the code. Nothing should be used from client/: report the spec that caused it.`)
    if (path.basename(file) !== 'zod.gen.ts')
      continue
    const stray = regexLiterals(source).find(body => !patterns.has(body))
    if (stray !== undefined)
      throw new SiteToApiError(`Generated ${path.relative(dir, file)} has the regular expression /${stray.slice(0, 80)}/, which is not a pattern of the spec; a spec value changed the code. Nothing should be used from client/: report the spec that caused it.`)
  }
}
