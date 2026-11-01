import { describe, expect, it } from 'vitest'
import { pureTopLevel } from './pure'

describe('pureTopLevel', () => {
  it('wraps each top-level schema call in a pure call and leaves the rest alone', () => {
    const source = `import * as z from 'zod/mini';\n\nexport const zA = z.object({\n    a: z.optional(z.string())\n});\n\nexport const zB = z.array(zA);\n\nexport const LIMIT = 3;\n\nfunction f() {\n    const inner = z.string();\n    return inner;\n}\n`
    expect(pureTopLevel(source)).toBe(`import * as z from 'zod/mini';\n\nexport const zA = /* @__PURE__ */ (() => z.object({\n    a: z.optional(z.string())\n}))();\n\nexport const zB = /* @__PURE__ */ (() => z.array(zA))();\n\nexport const LIMIT = 3;\n\nfunction f() {\n    const inner = z.string();\n    return inner;\n}\n`)
  })
})
