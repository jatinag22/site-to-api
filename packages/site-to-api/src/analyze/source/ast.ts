/**
 * Parsing helpers shared by endpoint discovery, string collection and excerpts: oxc parsing with
 * a language picked from the file name, offset ↔ line/column conversion, and a walk that knows
 * the name of the function enclosing each node.
 */
import type { ArrowFunctionExpression as ArrowNode, BinaryExpression, CallExpression, Expression, Function as FunctionNode, MemberExpression, NewExpression, ParserOptions, Program, PropertyKey, TemplateLiteral, VariableDeclarator, VisitorObject } from 'oxc-parser'
import { parseSync, Visitor } from 'oxc-parser'

type Lang = NonNullable<ParserOptions['lang']>

/** Picks the parser language from the file extension; bundles are always plain JavaScript. */
function langFor(path: string, bundle: boolean): Lang | null {
  if (bundle)
    return 'js'
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'ts'
    case 'tsx':
      return 'tsx'
    // Original `.js` sources of React apps often contain JSX, and the JSX grammar accepts plain JS.
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'jsx'
    default:
      return null
  }
}

/**
 * Parses a file. oxc recovers from syntax errors, so a partial program is still useful; `null`
 * only when the extension is not JavaScript or TypeScript.
 */
export function parseCode(path: string, text: string, bundle: boolean): Program | null {
  const lang = langFor(path, bundle)
  if (lang === null)
    return null
  return parseSync(path, text, { lang, sourceType: 'unambiguous', preserveParens: false }).program
}

/** Converts UTF-16 offsets to 1-based lines and columns and back. */
export class LineIndex {
  private readonly starts: number[] = [0]

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10)
        this.starts.push(i + 1)
    }
  }

  get lineCount(): number {
    return this.starts.length
  }

  /** 1-based line and column of an offset. */
  position(offset: number): { line: number, column: number } {
    let low = 0
    let high = this.starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((this.starts[mid] ?? 0) <= offset)
        low = mid
      else
        high = mid - 1
    }
    return { line: low + 1, column: offset - (this.starts[low] ?? 0) + 1 }
  }

  /** Offset of a 1-based line and column, clamped to the text. */
  offset(line: number, column: number): number {
    const start = this.lineStart(line)
    return Math.min(start + Math.max(column - 1, 0), this.lineEnd(line))
  }

  /** Offset where a 1-based line starts. */
  lineStart(line: number): number {
    const index = Math.min(Math.max(line - 1, 0), this.starts.length - 1)
    return this.starts[index] ?? 0
  }

  /** Offset just before the line break that ends a 1-based line. */
  lineEnd(line: number): number {
    const next = this.starts[Math.max(line, 1)]
    if (next === undefined)
      return this.text.length
    return this.text.charCodeAt(next - 2) === 13
      ? next - 2
      : next - 1
  }
}

/** Name of a property key when it is written literally. */
export function keyName(key: PropertyKey): string | null {
  if (key.type === 'Identifier')
    return key.name
  if (key.type === 'PrivateIdentifier')
    return `#${key.name}`
  if (key.type === 'Literal' && typeof key.value === 'string')
    return key.value
  return null
}

/** Property name of a member expression when it is written literally (`a.b`, `a['b']`, `a.#b`). */
export function memberPropertyName(node: MemberExpression): string | null {
  if (node.property.type === 'PrivateIdentifier')
    return `#${node.property.name}`
  if (!node.computed)
    return node.property.name
  return node.property.type === 'Literal' && typeof node.property.value === 'string'
    ? node.property.value
    : null
}

/** Readable name of a callee or assignment target: `fetch`, `axios.get`, `this.api.post`. */
export function expressionName(node: Expression): string | null {
  switch (node.type) {
    case 'Identifier':
      return node.name
    case 'ThisExpression':
      return 'this'
    case 'MemberExpression': {
      const property = memberPropertyName(node)
      if (property === null)
        return null
      const object = expressionName(node.object)
      return object === null
        ? property
        : `${object}.${property}`
    }
    case 'ChainExpression':
      if (node.expression.type === 'MemberExpression')
        return expressionName(node.expression)
      return node.expression.type === 'CallExpression'
        ? expressionName(node.expression.callee)
        : null
    default:
      return null
  }
}

/** A function node with its source span and the best name the code gives it. */
export interface FunctionSpan {
  start: number
  end: number
  name: string | null
}

type FunctionLike = FunctionNode | ArrowNode

/** Any literal node (`'a'`, `1`, `true`, `null`, `/re/`, `1n`). */
export type LiteralNode = Parameters<NonNullable<VisitorObject['Literal']>>[0]

/** Callbacks for the node types the source stage inspects. */
export interface CodeHandlers {
  CallExpression?: (node: CallExpression) => void
  NewExpression?: (node: NewExpression) => void
  Literal?: (node: LiteralNode) => void
  TemplateLiteral?: (node: TemplateLiteral) => void
  BinaryExpression?: (node: BinaryExpression) => void
  VariableDeclarator?: (node: VariableDeclarator) => void
}

/**
 * Walks a program, calling `handlers`, while tracking the enclosing function: `current()` returns
 * the innermost named function during any callback. Anonymous functions take the name of the
 * variable, property, method or assignment they are bound to, as stack traces do.
 * Returns the spans of every function, in source order.
 */
export function walkWithFunctions(
  program: Program,
  build: (current: () => string | null) => CodeHandlers,
): FunctionSpan[] {
  const hints = new Map<number, string>()
  const stack: FunctionSpan[] = []
  const spans: FunctionSpan[] = []
  const hint = (node: Expression | null | undefined, name: string | null): void => {
    if (node && name !== null && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'))
      hints.set(node.start, name)
  }
  const enter = (node: FunctionLike): void => {
    const span = { start: node.start, end: node.end, name: node.id?.name ?? hints.get(node.start) ?? null }
    stack.push(span)
    spans.push(span)
  }
  const exit = (): void => {
    stack.pop()
  }
  const current = (): string | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const name = stack[i]?.name
      if (name !== null && name !== undefined)
        return name
    }
    return null
  }
  const handlers = build(current)
  const visitor: VisitorObject = {
    VariableDeclarator(node) {
      if (node.id.type === 'Identifier')
        hint(node.init, node.id.name)
      handlers.VariableDeclarator?.(node)
    },
    Property(node) {
      if (node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression')
        hint(node.value, keyName(node.key))
    },
    MethodDefinition(node) {
      hint(node.value, keyName(node.key))
    },
    PropertyDefinition(node) {
      hint(node.value, keyName(node.key))
    },
    AssignmentExpression(node) {
      if (node.left.type === 'Identifier' || node.left.type === 'MemberExpression')
        hint(node.right, expressionName(node.left))
    },
    'FunctionDeclaration': enter,
    'FunctionExpression': enter,
    'ArrowFunctionExpression': enter,
    'FunctionDeclaration:exit': exit,
    'FunctionExpression:exit': exit,
    'ArrowFunctionExpression:exit': exit,
    CallExpression(node) {
      handlers.CallExpression?.(node)
    },
    NewExpression(node) {
      handlers.NewExpression?.(node)
    },
    Literal(node) {
      handlers.Literal?.(node)
    },
    TemplateLiteral(node) {
      handlers.TemplateLiteral?.(node)
    },
    BinaryExpression(node) {
      handlers.BinaryExpression?.(node)
    },
  }
  new Visitor(visitor).visit(program)
  return spans
}
