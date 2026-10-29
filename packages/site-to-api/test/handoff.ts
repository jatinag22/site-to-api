/**
 * A small handoff folder for the MCP tests (decision 0043), in the format `build` writes: one
 * OpenAPI spec covering every kind of operation the servers treat differently, `flows.json`,
 * `build.json` and one source excerpt. Every value is made up.
 */
import type { FlowsDocument } from '../src/model'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { toYaml } from '../src/emit/openapi'
import { FLOWS_FORMAT_VERSION } from '../src/model'

export const HOST = 'shop.example.com'

function json(schema: object, examples?: Record<string, { value: unknown }>): object {
  return {
    content: {
      'application/json': {
        schema,
        ...(examples === undefined
          ? {}
          : { examples }),
      },
    },
  }
}

/** The spec: reads, writes, GraphQL, a dispatcher, a bot-protection step and a code-only endpoint. */
export function shopSpec(serverUrl = `https://${HOST}`): object {
  return {
    openapi: '3.1.0',
    info: { title: HOST, version: '0.0.0' },
    servers: [
      { url: serverUrl },
    ],
    paths: {
      '/login': {
        get: {
          'operationId': 'getLogin',
          'summary': 'Page login.',
          'x-site-to-api-kind': 'page',
          'responses': {
            200: {
              description: 'OK',
              content: {
                'text/html': {
                  schema: { type: 'string' },
                },
              },
            },
          },
        },
      },
      '/api/products/{productId}': {
        parameters: [
          {
            'name': 'productId',
            'in': 'path',
            'required': true,
            'schema': {
              type: 'string',
              examples: ['1007'],
            },
            'x-site-to-api-origin': {
              kind: 'step',
              step: 's1',
              output: 'body./items/*/id',
              transform: 'none',
            },
          },
        ],
        get: {
          'operationId': 'getApiProductsByProductId',
          'summary': 'Get api products by product id. Returns id, name, examples.',
          'x-site-to-api-kind': 'api',
          'x-site-to-api-source': [
            { file: 'src/api/products.ts', line: 12, function: 'loadProduct' },
          ],
          'parameters': [
            {
              'name': 'x-requested-with',
              'in': 'header',
              'required': false,
              'x-site-to-api-constant': true,
              'schema': { type: 'string', default: 'XMLHttpRequest' },
            },
            {
              name: 'session',
              in: 'cookie',
              required: true,
              schema: { type: 'string' },
            },
          ],
          'responses': {
            200: {
              description: 'OK',
              ...json({
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  // A field that happens to be called `examples`: a name, not the keyword.
                  examples: {
                    type: 'array',
                    items: { type: 'string' },
                    examples: [
                      ['x'],
                    ],
                  },
                },
              }, {
                example1: {
                  value: { id: '1007', name: 'Xxxxx', examples: [] },
                },
              }),
            },
          },
        },
      },
      '/api/session': {
        post: {
          'operationId': 'postApiSession',
          'summary': 'Post api session. Returns token.',
          'x-site-to-api-kind': 'api',
          'parameters': [
            {
              'name': 'x-csrf-token',
              'in': 'header',
              'required': false,
              'schema': {
                type: 'string',
                examples: ['<redacted: 40 hex chars>'],
              },
              'x-site-to-api-origin': {
                kind: 'html',
                step: 'sign-in.s1',
                selector: 'meta[name="csrf-token"]',
                attr: 'content',
                pattern: null,
                confidence: 'high',
              },
            },
          ],
          'requestBody': {
            required: true,
            ...json({
              type: 'object',
              required: ['username'],
              properties: {
                username: {
                  'type': 'string',
                  'x-site-to-api-origin': { kind: 'user-input', field: 'username' },
                },
                password: {
                  'type': 'string',
                  'x-site-to-api-origin': { kind: 'computed', computedId: 'c1' },
                },
              },
            }, {
              example1: {
                value: { username: 'xxxx', password: '<redacted: 344 base64 chars>' },
              },
            }),
          },
          'responses': {
            200: {
              description: 'OK',
              ...json({
                type: 'object',
                properties: {
                  token: { type: 'string' },
                },
              }),
            },
          },
        },
      },
      '/api/logout': {
        get: {
          'operationId': 'getApiLogout',
          'summary': 'Get api logout.',
          'x-site-to-api-kind': 'api',
          'responses': {
            204: { description: 'No content' },
          },
        },
      },
      '/api/graphql#ProductStock': {
        post: {
          'operationId': 'productStock',
          'summary': 'GraphQL query ProductStock (POST /api/graphql).',
          'x-site-to-api-kind': 'api',
          'x-site-to-api-graphql': {
            endpoint: '/api/graphql',
            operationName: 'ProductStock',
            operationType: 'query',
            operationTypeFrom: 'document',
            persistedQuery: null,
            document: 'query ProductStock($id: Int!) { stock(id: $id) }',
            batched: false,
            sent: {
              body: ['query', 'variables'],
              query: [],
            },
          },
          'requestBody': {
            required: true,
            ...json({
              type: 'object',
              required: ['query', 'variables'],
              properties: {
                query: { const: 'query ProductStock($id: Int!) { stock(id: $id) }', default: 'query ProductStock($id: Int!) { stock(id: $id) }' },
                variables: {
                  type: 'object',
                  required: ['id'],
                  properties: {
                    id: { type: 'integer' },
                  },
                },
              },
            }),
          },
          'responses': {
            200: {
              description: 'OK',
              ...json({
                type: 'object',
                properties: {
                  data: { type: 'object' },
                },
              }),
            },
          },
        },
      },
      '/api/graphql#AddToWishlist': {
        post: {
          'operationId': 'addToWishlist',
          'summary': 'GraphQL mutation AddToWishlist (POST /api/graphql).',
          'x-site-to-api-kind': 'api',
          'x-site-to-api-graphql': {
            endpoint: '/api/graphql',
            operationName: 'AddToWishlist',
            operationType: 'mutation',
            operationTypeFrom: 'document',
            persistedQuery: null,
            document: 'mutation AddToWishlist($id: Int!) { add(id: $id) }',
            batched: false,
            sent: {
              body: ['query', 'variables'],
              query: [],
            },
          },
          'requestBody': {
            required: true,
            ...json({
              type: 'object',
              required: ['query', 'variables'],
              properties: {
                query: { const: 'mutation AddToWishlist($id: Int!) { add(id: $id) }', default: 'mutation AddToWishlist($id: Int!) { add(id: $id) }' },
                variables: {
                  type: 'object',
                  required: ['id'],
                  properties: {
                    id: { type: 'integer' },
                  },
                },
              },
            }),
          },
          'responses': {
            200: {
              description: 'OK',
              ...json({
                type: 'object',
                properties: {
                  data: { type: 'object' },
                },
              }),
            },
          },
        },
      },
      '/api/store-api#getStoreInfo': {
        get: {
          'operationId': 'getStoreInfo',
          'summary': 'Function getStoreInfo of /api/store-api.',
          'x-site-to-api-kind': 'api',
          'x-site-to-api-dispatch': {
            endpoint: '/api/store-api',
            parameter: 'functionName',
            in: 'query',
            value: 'getStoreInfo',
          },
          'parameters': [
            {
              name: 'functionName',
              in: 'query',
              required: true,
              schema: { const: 'getStoreInfo', default: 'getStoreInfo' },
            },
            {
              name: 'slug',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
          ],
          'responses': {
            200: {
              description: 'OK',
              ...json({
                type: 'object',
                properties: {
                  name: { type: 'string' },
                },
              }),
            },
          },
        },
      },
      '/shield/collect': {
        post: {
          'operationId': 'postShieldCollect',
          'summary': 'Bot protection sensor.',
          'x-site-to-api-kind': 'bot-protection',
          'responses': {
            200: { description: 'OK' },
          },
        },
      },
      '/api/products/{productId}/related': {
        get: {
          'operationId': 'getApiProductsByProductIdRelated',
          'summary': 'Seen in code only.',
          'x-site-to-api-kind': 'api',
          'x-site-to-api-source-only': true,
          'x-site-to-api-method-unknown': true,
          'parameters': [
            {
              name: 'productId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          'responses': {
            200: { description: 'OK' },
          },
        },
      },
    },
  }
}

export const shopFlows: FlowsDocument = {
  formatVersion: FLOWS_FORMAT_VERSION,
  generatedBy: 'site-to-api test',
  sessions: ['s-one', 's-two'],
  session: [
    {
      host: HOST,
      requires: 'cookies',
      cookies: [
        { name: 'session', setBy: 'sign-in.s2', source: 'response' },
      ],
      botProtection: [],
      probed: false,
    },
  ],
  flows: [
    {
      id: 'sign-in',
      name: 'Sign in',
      trigger: { kind: 'submit', label: 'Sign in', pageUrl: `https://${HOST}/login` },
      steps: [
        {
          id: 's1',
          operationId: 'getLogin',
          kind: 'page',
          browserOnly: false,
          summary: 'Open the login page',
          sentFrom: null,
          inputs: {},
          outputs: {},
          observedIn: [],
        },
        {
          id: 's2',
          operationId: 'postApiSession',
          kind: 'api',
          browserOnly: false,
          summary: 'Sign in',
          sentFrom: {
            file: 'src/auth/login.ts',
            line: 40,
            column: 3,
            functionName: 'signIn',
            original: true,
            excerpt: 'source/src/auth/login.L37-50.ts.md',
          },
          inputs: {
            'header.x-csrf-token': {
              kind: 'html',
              step: 's1',
              selector: 'meta[name="csrf-token"]',
              attr: 'content',
              pattern: null,
              confidence: 'high',
            },
            'body./profile/locale': { kind: 'constant', value: 'en-IN' },
          },
          outputs: { token: 'body./token' },
          observedIn: [],
        },
      ],
      seenInSessions: 2,
    },
    {
      id: 'browse',
      name: 'Browse',
      trigger: { kind: 'navigate', label: 'Products', pageUrl: `https://${HOST}/` },
      steps: [
        {
          id: 's1',
          operationId: 'getApiProductsByProductId',
          kind: 'api',
          browserOnly: false,
          summary: 'Load a product',
          sentFrom: null,
          inputs: {},
          outputs: {},
          observedIn: [],
        },
      ],
      seenInSessions: 1,
    },
  ],
  computedValues: [
    {
      id: 'c1',
      operationId: 'postApiSession',
      input: 'body./password',
      producedBy: {
        file: 'src/auth/crypto.ts',
        line: 20,
        column: 1,
        functionName: 'encryptPassword',
        original: true,
        excerpt: 'source/src/auth/crypto.L18-28.ts.md',
      },
      calledFrom: null,
      api: 'crypto.subtle.encrypt',
      details: null,
      uses: [],
      evidence: 'transform-hook',
    },
  ],
}

/** Writes the folder into a new temporary directory and returns its path. */
export async function writeShopHandoff(options: { examples?: 'masked' | 'raw' | 'none' | null, serverUrl?: string } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-mcp-'))
  await mkdir(path.join(dir, 'specs'), { recursive: true })
  await writeFile(path.join(dir, 'specs', `${HOST}.yaml`), toYaml(shopSpec(options.serverUrl)))
  await writeFile(path.join(dir, 'flows.json'), `${JSON.stringify(shopFlows, null, 2)}\n`)
  if (options.examples !== null) {
    await writeFile(path.join(dir, 'build.json'), `${JSON.stringify({
      formatVersion: 1,
      generatedBy: 'site-to-api test',
      examples: options.examples ?? 'masked',
      hosts: { include: [], exclude: [] },
      client: true,
      sticky: [],
    }, null, 2)}\n`)
  }
  await mkdir(path.join(dir, 'source', 'src', 'auth'), { recursive: true })
  await writeFile(path.join(dir, 'source', 'src', 'auth', 'crypto.L18-28.ts.md'), '# Excerpt of `src/auth/crypto.ts:20:1`\n\n```ts\nexport async function encryptPassword() {}\n```\n')
  // A file next to the folder that get_source must never reach.
  await writeFile(path.join(dir, 'secret.txt'), 'not an excerpt')
  return dir
}
