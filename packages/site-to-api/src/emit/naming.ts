/**
 * Names of generated client symbols. They come from hey-api's own `toCase`, the function it uses
 * when generating (decision 0010), so documents point at symbols that `gen` really produces.
 * Checked against hey-api 0.99.0 output: SDK function = camelCase(operationId), response schema
 * = `z` + PascalCase(operationId) + `Response`.
 */
import { toCase } from '@hey-api/shared'

/** The SDK function hey-api generates for an operation. */
export function sdkFunctionName(operationId: string): string {
  return toCase(operationId, 'camelCase')
}

/** The Zod schema hey-api generates for an operation's successful response. */
export function responseSchemaName(operationId: string): string {
  return `z${toCase(operationId, 'PascalCase')}Response`
}

/** The request type hey-api generates for an operation (`body`, `headers`, `path`, `query`). */
export function dataTypeName(operationId: string): string {
  return `${toCase(operationId, 'PascalCase')}Data`
}

/** Words no binding can be named, in a module (strict mode) or anywhere in ECMAScript. */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

/**
 * Names the generated wrapper modules (`graphql.ts`, `dispatch.ts`) import or declare
 * themselves; a function of the same name would collide with them.
 */
const GENERATED_NAMES: ReadonlySet<string> = new Set([
  'Options',
  'client',
  'fetchWithoutFragment',
  'graphqlQuerySerializer',
  'options',
  'rest',
  'sdk',
])

const PLAIN_IDENTIFIER = /^[a-z_$][\w$]*$/i

/**
 * Whether the SDK function hey-api derives from `operationId` can be declared as a function in a
 * generated module: a plain identifier, not a reserved word (strict mode included) and not a
 * name the generated modules use themselves.
 */
export function isUsableFunctionName(operationId: string): boolean {
  const name = sdkFunctionName(operationId)
  return PLAIN_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name) && !GENERATED_NAMES.has(name)
}
