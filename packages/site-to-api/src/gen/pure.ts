/**
 * Marks the module-level schema definitions of hey-api's `zod.gen.ts` as free of side effects
 * (decision 0057). Each is a `z.object(…)` call, which a bundler must assume has side effects, so
 * importing one operation kept every schema of the host. Wrapped in a `@__PURE__` call, a schema
 * nobody uses is dropped.
 */
import ts from 'typescript'
import { pure } from './render'

/** `source` with the initializer of every top-level `const` that is a call wrapped by {@link pure}. */
export function pureTopLevel(source: string): string {
  const file = ts.createSourceFile('zod.gen.ts', source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
  const edits: Array<{ start: number, end: number, text: string }> = []
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement))
      continue
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (initializer !== undefined && ts.isCallExpression(initializer)) {
        edits.push({
          start: initializer.getStart(file),
          end: initializer.getEnd(),
          text: pure(initializer.getText(file)),
        })
      }
    }
  }
  let result = source
  for (const edit of edits.reverse())
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`
  return result
}
