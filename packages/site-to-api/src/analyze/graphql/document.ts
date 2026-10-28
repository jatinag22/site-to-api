/**
 * Just enough of the GraphQL grammar to read a captured query document: which operations it
 * defines (type and name) and a whitespace-normalised form for stable hashing. Not a validator:
 * anything that is not a sequence of definitions is rejected, so a JSON field that merely happens
 * to be called `query` (a search box) is never taken for GraphQL.
 */
import type { GraphqlOperationType } from '../../model'

interface Token {
  kind: 'name' | 'punct' | 'string' | 'number'
  text: string
}

/**
 * One lexical token or ignored run, matched at the current position: whitespace (`\s` covers
 * the byte order mark) and commas,
 * comments, block strings, strings, `...`, punctuators, names and numbers (GraphQL spec, 2.1).
 */
const LEXEME = /[\s,]+|#[^\n\r]*|"""(?:\\"""|(?!""")[\s\S])*"""|"(?:\\.|[^"\\\n\r])*"|\.\.\.|[!$&():=@[\]{|}]|[_A-Z]\w*|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/giy

function kindOf(lexeme: string): Token['kind'] | null {
  const first = lexeme.charAt(0)
  if (/[\s,#]/.test(first))
    return null
  if (first === '"')
    return 'string'
  if (/[_A-Z]/i.test(first))
    return 'name'
  if (/[-\d]/.test(first))
    return 'number'
  return 'punct'
}

/** The tokens of a document, or null when it contains something no GraphQL document can. */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = []
  LEXEME.lastIndex = 0
  while (LEXEME.lastIndex < text.length) {
    const match = LEXEME.exec(text)
    if (match === null)
      return null
    const kind = kindOf(match[0])
    if (kind !== null)
      tokens.push({ kind, text: match[0] })
  }
  return tokens
}

/** One operation definition of a document. Fragments are not listed. */
export interface OperationDefinition {
  type: Exclude<GraphqlOperationType, 'unknown'>
  /** Null for an anonymous operation (`{ me { id } }` or `query { ... }`). */
  name: string | null
}

const OPERATION_KEYWORDS = new Set(['query', 'mutation', 'subscription'])
const CLOSING: Record<string, string> = { '{': '}', '(': ')', '[': ']' }

/**
 * Whether `tokens[i]` may stand where it is. Selection sets hold only fields, aliases, fragment
 * spreads and directives; strings, numbers and lists appear only inside arguments or variable
 * definitions (in parentheses). A `:` always follows a name (alias, argument, object field or
 * variable), and a selection set is never empty. This is what tells a GraphQL document from a
 * JSON object such as `{"status":"active"}` sent in a field called `query`.
 */
function fitsHere(tokens: Token[], i: number, stack: readonly string[]): boolean {
  const token = tokens[i]!
  const inParentheses = stack.includes(')')
  if (token.kind === 'string' || token.kind === 'number' || token.text === '[')
    return inParentheses
  if (token.text === ':')
    return tokens[i - 1]?.kind === 'name'
  if (token.text === '{' && !inParentheses) {
    const next = tokens[i + 1]
    return next !== undefined && (next.kind === 'name' || next.text === '...')
  }
  return true
}

/**
 * Index just past the definition that starts at `start`: everything up to and including the
 * selection set that closes it. -1 when brackets do not balance, no selection set follows, or a
 * token cannot be part of a GraphQL definition (see {@link fitsHere}).
 */
function definitionEnd(tokens: Token[], start: number): number {
  const stack: string[] = []
  for (let i = start; i < tokens.length; i++) {
    if (!fitsHere(tokens, i, stack))
      return -1
    const step = bracketStep(tokens[i]!, stack)
    if (step === 'unbalanced')
      return -1
    if (step === 'closed')
      return i + 1
  }
  return -1
}

/**
 * Applies one token to the bracket stack: `closed` when it closes the definition's outermost
 * selection set, `unbalanced` when it closes a bracket that is not open.
 */
function bracketStep(token: Token, stack: string[]): 'open' | 'closed' | 'unbalanced' {
  if (token.kind !== 'punct')
    return 'open'
  const closing = CLOSING[token.text]
  if (closing !== undefined) {
    stack.push(closing)
    return 'open'
  }
  if (token.text !== '}' && token.text !== ')' && token.text !== ']')
    return 'open'
  if (stack.pop() !== token.text)
    return 'unbalanced'
  return stack.length === 0 && token.text === '}'
    ? 'closed'
    : 'open'
}

function operationType(keyword: string): OperationDefinition['type'] {
  return keyword === 'mutation' || keyword === 'subscription'
    ? keyword
    : 'query'
}

/**
 * What the definition starting at `tokens[i]` is: an operation, `fragment` (skipped), or null when
 * no definition can start with that token.
 */
function definitionAt(tokens: Token[], i: number): OperationDefinition | 'fragment' | null {
  const token = tokens[i]
  if (token?.kind === 'punct' && token.text === '{')
    return { type: 'query', name: null }
  if (token?.kind !== 'name')
    return null
  if (token.text === 'fragment')
    return 'fragment'
  if (!OPERATION_KEYWORDS.has(token.text))
    return null
  const next = tokens[i + 1]
  return {
    type: operationType(token.text),
    name: next?.kind === 'name'
      ? next.text
      : null,
  }
}

/**
 * The operations a document defines, in order, or null when the text is not a GraphQL
 * document (or defines no operation, only fragments).
 */
export function readOperations(text: string): OperationDefinition[] | null {
  const tokens = tokenize(text)
  if (tokens === null || tokens.length === 0)
    return null
  const operations: OperationDefinition[] = []
  let i = 0
  while (i < tokens.length) {
    const definition = definitionAt(tokens, i)
    const end = definition === null
      ? -1
      : definitionEnd(tokens, i)
    if (end === -1)
      return null
    if (definition !== 'fragment' && definition !== null)
      operations.push(definition)
    i = end
  }
  return operations.length > 0
    ? operations
    : null
}

/**
 * The operation a request runs: the one named `operationName`, or the only one. Null when the
 * document defines several and the request does not say which.
 */
export function selectOperation(operations: OperationDefinition[], operationName: string | null): OperationDefinition | null {
  if (operationName !== null)
    return operations.find(operation => operation.name === operationName) ?? null
  return operations.length === 1
    ? operations[0]!
    : null
}

/**
 * The document with comments removed and tokens separated by single spaces, so two copies that
 * differ only in layout hash the same. Null when the text is not a GraphQL document.
 */
export function normalizeDocument(text: string): string | null {
  const tokens = tokenize(text)
  return tokens === null
    ? null
    : tokens.map(token => token.text).join(' ')
}
