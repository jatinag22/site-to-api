/**
 * A spec whose every site-controlled field tries to become code in the generated client
 * (decision 0043): documentation, examples, enum/const/default values, property and parameter
 * names, formats, operation ids, paths and patterns, including the encodings hey-api decodes.
 */
import { shopSpec } from './handoff'

/** What a hostile value runs when it escapes its string or comment. */
export const PWN = 'globalThis.__pwn=1'

/** Closes a comment, a string, a template and a regex, with line terminators. */
export const HOSTILE = `x*/ ${PWN}; /* '" \` \${${PWN}} </script> \\ \u2028\u2029 end`

/** Patterns that broke hey-api's regex literals, raw and in the encodings it decodes. */
export const HOSTILE_PATTERNS = [
  `a/, ${PWN}, /b`,
  `a\\x2f, ${PWN}, \\x2fb`,
  `a\\u002f, ${PWN}, \\u002fb`,
  `a\\u{2f}, ${PWN}, \\u{2f}b`,
  `a\\cO/, ${PWN}, /b`,
  `*/ ${PWN} /*`,
  'a',
  'b',
]

/** The shop spec plus one operation full of hostile values. */
export function hostileShopSpec(serverUrl?: string): object {
  const spec = shopSpec(serverUrl)
  const paths = Reflect.get(spec, 'paths')
  Reflect.set(spec, 'info', { title: HOSTILE, version: '1', description: HOSTILE })
  const property = (extra: object): object => ({
    type: 'string',
    description: HOSTILE,
    title: HOSTILE,
    example: HOSTILE,
    examples: [HOSTILE],
    format: HOSTILE,
    ...extra,
  })
  Reflect.set(paths, `/api/evil/${HOSTILE}`, {
    summary: HOSTILE,
    description: HOSTILE,
    get: {
      'operationId': 'getEvil',
      'summary': HOSTILE,
      'description': HOSTILE,
      'x-site-to-api-kind': 'api',
      'parameters': [
        {
          name: `q'];${PWN};//`,
          in: 'query',
          required: false,
          description: HOSTILE,
          example: HOSTILE,
          schema: property({
            default: HOSTILE,
            enum: [HOSTILE, 'plain'],
          }),
        },
        {
          'name': `x-h"${PWN}`,
          'in': 'header',
          'x-site-to-api-constant': true,
          'schema': { type: 'string', default: HOSTILE },
        },
      ],
      'responses': {
        200: {
          description: HOSTILE,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: HOSTILE,
                title: HOSTILE,
                properties: {
                  [`k'];${PWN};//`]: property({ const: HOSTILE, default: HOSTILE }),
                  [HOSTILE]: { type: 'integer', description: HOSTILE },
                  ...Object.fromEntries(HOSTILE_PATTERNS.map((pattern, index) => [
                    `p${index}`,
                    property({ pattern }),
                  ])),
                },
              },
              example: { hostile: HOSTILE },
            },
          },
        },
      },
    },
  })
  return spec
}
