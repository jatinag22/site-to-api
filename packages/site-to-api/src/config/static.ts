/**
 * Reads `outDir` from a `.ts`/`.js` config file without running it (decision 0057). `mcp` never
 * runs project code (an MCP client starts it in every project without asking), yet a project
 * whose only config is `site-to-api.config.ts` should not need the handoff folder repeated on
 * the command line. A plain string literal is all this reads; anything computed is left out.
 */
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

function literal(node: ts.Expression): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : null
}

/**
 * The string literal the config file gives the top-level `key` of its object literal (`outDir`),
 * or `null` when there is none or more than one candidate, or it is computed.
 */
export async function staticConfigValue(file: string, key: string): Promise<string | null> {
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.ES2023, true)
  const found: (string | null)[] = []
  const visit = (node: ts.Node, depth: number): void => {
    if (ts.isObjectLiteralExpression(node)) {
      // Only the outermost object literal: `gen: { clientDir }` is a nested key, not `outDir`.
      if (depth === 0) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property) && propertyName(property.name) === key)
            found.push(literal(property.initializer))
        }
      }
      ts.forEachChild(node, child => visit(child, depth + 1))
      return
    }
    ts.forEachChild(node, child => visit(child, depth))
  }
  visit(source, 0)
  const [value] = found
  return found.length === 1 && value !== undefined
    ? value
    : null
}
