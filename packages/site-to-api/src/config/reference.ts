/**
 * The configuration reference (`docs/configuration.md`), generated from the config schema: keys,
 * types and defaults from `ConfigSchema` itself, meanings from the JSDoc of each key in
 * `schema.ts`. Pure: the schema's source text in, Markdown out. A test compares the result with
 * the committed file, so the doc cannot drift from the schema.
 */
import ts from 'typescript'
import { z } from 'zod'
import { envName } from './errors'
import { ConfigSchema } from './schema'

/** One key of the reference. */
interface ReferenceEntry {
  path: string[]
  type: string
  default: unknown
  description: string
}

/** The receiver of a call chain: `z.strictObject({...}).prefault({})` → `z.strictObject({...})`. */
function objectLiteralOf(node: ts.Expression): ts.ObjectLiteralExpression | null {
  let current: ts.Expression = node
  while (ts.isCallExpression(current)) {
    const [first] = current.arguments
    if (ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'strictObject' && first !== undefined && ts.isObjectLiteralExpression(first))
      return first
    current = ts.isPropertyAccessExpression(current.expression)
      ? current.expression.expression
      : current.expression
  }
  return null
}

/** The JSDoc of every key in `ConfigSchema`'s object literal, by dotted path, on one line each. */
function schemaDescriptions(source: string): Map<string, string> {
  const file = ts.createSourceFile('schema.ts', source, ts.ScriptTarget.Latest, true)
  const result = new Map<string, string>()
  const visit = (literal: ts.ObjectLiteralExpression, prefix: string[]): void => {
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name))
        continue
      const path = [...prefix, property.name.text]
      const text = ts.getJSDocCommentsAndTags(property)
        .flatMap(doc => ts.isJSDoc(doc)
          ? [ts.getTextOfJSDocComment(doc.comment) ?? '']
          : [])
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text !== '')
        result.set(path.join('.'), text)
      const nested = objectLiteralOf(property.initializer)
      if (nested !== null)
        visit(nested, path)
    }
  }
  file.forEachChild((node) => {
    if (!ts.isVariableStatement(node))
      return
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'ConfigSchema' && declaration.initializer !== undefined) {
        const literal = objectLiteralOf(declaration.initializer)
        if (literal !== null)
          visit(literal, [])
      }
    }
  })
  return result
}

/** The parts of a JSON Schema node the reference reads, checked rather than cast. */
const JsonSchemaNodeSchema = z.looseObject({
  type: z.union([
    z.string(),
    z.array(z.string()),
  ]).optional(),
  enum: z.array(z.unknown()).optional(),
  default: z.unknown().optional(),
  get anyOf() {
    return z.array(JsonSchemaNodeSchema).optional()
  },
  get items() {
    return JsonSchemaNodeSchema.optional()
  },
  get properties() {
    return z.record(z.string(), JsonSchemaNodeSchema).optional()
  },
})
type JsonSchemaNode = z.infer<typeof JsonSchemaNodeSchema>

function typeLabel(node: JsonSchemaNode): string {
  if (node.anyOf !== undefined)
    return node.anyOf.map(typeLabel).join(' or ')
  if (node.enum !== undefined)
    return node.enum.map(value => `\`${JSON.stringify(value)}\``).join(', ')
  if (node.type === 'array') {
    return `array of ${node.items === undefined
      ? 'values'
      : typeLabel(node.items)}`
  }
  if (node.type === 'object' && node.properties !== undefined)
    return `object (${Object.keys(node.properties).map(key => `\`${key}\``).join(', ')})`
  if (node.type === 'integer')
    return 'whole number'
  return Array.isArray(node.type)
    ? node.type.join(' or ')
    : node.type ?? 'value'
}

/** Every leaf key: objects are sections, everything else (arrays of objects too) is a key. */
function leaves(node: JsonSchemaNode, path: string[], descriptions: ReadonlyMap<string, string>): ReferenceEntry[] {
  if (node.type === 'object' && node.properties !== undefined) {
    return Object.entries(node.properties).flatMap(([key, child]) => leaves(child, [...path, key], descriptions))
  }
  return [
    {
      path,
      type: typeLabel(node),
      default: node.default,
      description: descriptions.get(path.join('.')) ?? '',
    },
  ]
}

/** The keys of the reference, in schema order. Every key has a description, or the test fails. */
export function referenceEntries(source: string): ReferenceEntry[] {
  const schema = JsonSchemaNodeSchema.parse(z.toJSONSchema(ConfigSchema, { io: 'input' }))
  return leaves(schema, [], schemaDescriptions(source))
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|')
}

/** `docs/configuration.md`. */
export function configurationReference(source: string): string {
  const entries = referenceEntries(source)
  const sections = new Map<string, ReferenceEntry[]>()
  for (const entry of entries) {
    const section = entry.path.length === 1
      ? ''
      : entry.path.slice(0, -1).join('.')
    sections.set(section, [
      ...sections.get(section) ?? [],
      entry,
    ])
  }
  const lines = [
    '# Configuration reference',
    '',
    '<!-- Generated from packages/site-to-api/src/config/schema.ts; do not edit by hand. Regenerate with:',
    '     UPDATE_CONFIG_DOC=1 pnpm exec vitest --run packages/site-to-api/src/config/reference.test.ts -->',
    '',
    'Every key `site-to-api` reads, with its default and meaning. Values come from, in increasing',
    'precedence: the defaults below, a config file (`site-to-api.config.{ts,mts,js,mjs,json}`, or',
    '`--config`), `SITE_TO_API_*` environment variables, and CLI flags (decision 0006). Unknown keys',
    'are an error. `site-to-api config` prints the values in effect and where each came from.',
    '',
    'Environment variables use `__` between levels and `_` between words, and are parsed as JSON',
    'when they can be: `SITE_TO_API_PROBE__MAX_RPS=0.5`, `SITE_TO_API_HOSTS__INCLUDE=\'["*.example.com"]\'`.',
    '',
  ]
  for (const [section, items] of sections) {
    lines.push(`## ${section === ''
      ? 'Top level'
      : `\`${section}\``}`, '')
    lines.push('| Key | Type | Default | Environment variable | Meaning |', '| --- | --- | --- | --- | --- |')
    for (const entry of items)
      lines.push(`| \`${entry.path.join('.')}\` | ${cell(entry.type)} | \`${cell(JSON.stringify(entry.default ?? null))}\` | \`${envName(entry.path)}\` | ${cell(entry.description)} |`)
    lines.push('')
  }
  return lines.join('\n')
}
