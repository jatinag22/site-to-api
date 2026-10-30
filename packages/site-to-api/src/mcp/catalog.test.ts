import type { OperationEntry } from './catalog'
import { describe, expect, it } from 'vitest'
import { HOST, shopFlows, shopSpec } from '../../test/handoff'
import { OpenApiDocumentSchema } from '../gen/spec'
import { catalogOperations, clientArguments, describeOrigin, findOperation, operationInputs, searchOperations, withoutExamples } from './catalog'

const host = { file: `${HOST}.yaml`, host: HOST, identifier: 'shop_example_com' }

function entries(): OperationEntry[] {
  return catalogOperations(host, OpenApiDocumentSchema.parse(shopSpec()), [], shopFlows, [])
}

function entry(operationId: string): OperationEntry {
  const found = findOperation(entries(), operationId)
  if (typeof found === 'string')
    throw new TypeError(found)
  return found
}

describe('catalogOperations', () => {
  it('lists every operation in spec order with its kind, GraphQL and dispatcher facts', () => {
    const all = entries()
    expect(all.map(item => item.operationId)).toEqual([
      'getLogin',
      'getApiProductsByProductId',
      'postApiSession',
      'getApiLogout',
      'productStock',
      'addToWishlist',
      'getStoreInfo',
      'postShieldCollect',
      'getApiProductsByProductIdRelated',
    ])
    expect(entry('productStock')).toMatchObject({
      method: 'POST',
      graphql: { operationType: 'query' },
      client: { kind: 'graphql', variablesIn: 'body' },
    })
    expect(entry('getStoreInfo')).toMatchObject({
      dispatch: { parameter: 'functionName', value: 'getStoreInfo' },
      client: { kind: 'dispatch', argument: 'query' },
    })
    expect(entry('postShieldCollect').kind).toBe('bot-protection')
    expect(entry('getApiProductsByProductIdRelated')).toMatchObject({ sourceOnly: true, methodUnknown: true })
    expect(entry('postApiSession').steps).toEqual(['sign-in.s2'])
  })

  it('keeps path item parameters apart from the operation\'s own', () => {
    const product = entry('getApiProductsByProductId')
    expect(product.pathItemParameters).toHaveLength(1)
    expect(product.parameters).toHaveLength(3)
  })

  it('leaves out operations without an operationId, with a warning', () => {
    const warnings: string[] = []
    const document = OpenApiDocumentSchema.parse({
      openapi: '3.1.0',
      paths: {
        '/x': {
          get: { responses: {} },
        },
      },
    })
    expect(catalogOperations(host, document, [], shopFlows, warnings)).toEqual([])
    expect(warnings[0]).toContain('GET /x')
  })
})

describe('searchOperations and findOperation', () => {
  it('matches every word, ranks id and path matches first, and pages', () => {
    const found = searchOperations(entries(), { query: 'products', limit: 1, offset: 0 })
    // `ProductStock` contains the word too.
    expect(found.total).toBe(3)
    expect(found.items.map(item => item.operationId)).toEqual(['getApiProductsByProductId'])
    expect(searchOperations(entries(), { query: 'products', limit: 5, offset: 1 }).items.map(item => item.operationId)).toEqual(['productStock', 'getApiProductsByProductIdRelated'])
    expect(searchOperations(entries(), { query: 'session post', limit: 5, offset: 0 }).items.map(item => item.operationId)).toEqual(['postApiSession'])
    expect(searchOperations(entries(), { query: 'graphql stock', limit: 10, offset: 0 }).items.map(item => item.operationId)).toEqual(['productStock'])
    expect(searchOperations(entries(), { kind: 'page', limit: 10, offset: 0 }).total).toBe(1)
    expect(searchOperations(entries(), { host: 'other.example', limit: 10, offset: 0 }).total).toBe(0)
  })

  it('explains a missing or ambiguous id', () => {
    expect(findOperation(entries(), 'nope')).toContain('search_operations')
    const twice = [
      ...entries(),
      {
        ...entry('getLogin'),
        host: 'www.example.com',
      },
    ]
    expect(findOperation(twice, 'getLogin')).toContain('pass host')
    expect(findOperation(twice, 'getLogin', 'www.example.com')).toMatchObject({ host: 'www.example.com' })
  })
})

describe('withoutExamples', () => {
  it('drops example keywords but keeps a field named examples', () => {
    const slice = withoutExamples(entry('getApiProductsByProductId').operation)
    const text = JSON.stringify(slice)
    expect(text).not.toContain('example1')
    expect(text).not.toContain('"examples":[["x"]]')
    expect(text).toContain('"examples":{"type":"array","items":{"type":"string"}}')
  })
})

describe('operationInputs', () => {
  it('describes each input and where its value comes from, qualifying step references', () => {
    const inputs = operationInputs(entry('postApiSession'), shopFlows)
    expect(inputs.map(input => input.location)).toEqual([
      'header.x-csrf-token',
      'body./username',
      'body./password',
      'body./profile/locale',
    ])
    expect(inputs[0]?.from).toBe('html meta[name="csrf-token"] @content of the response of sign-in.s1 (getLogin)')
    expect(inputs[1]).toMatchObject({ required: true, type: 'string', from: 'typed by the person into username' })
    expect(inputs[2]?.from).toContain('computed value c1')
    expect(inputs[3]?.from).toBe('constant: send the captured value')
  })

  it('marks constants the client sends by itself and parameters with no traced origin', () => {
    const inputs = operationInputs(entry('getApiProductsByProductId'), shopFlows)
    expect(inputs.find(input => input.location === 'header.x-requested-with')).toMatchObject({ constant: 'XMLHttpRequest' })
    expect(inputs.find(input => input.location === 'cookie.session')?.from).toContain('not traced')
    expect(inputs.find(input => input.location === 'path.productId')?.from).toBe('response of browse.s1 (getApiProductsByProductId) at body./items/*/id')
  })
})

describe('describeOrigin', () => {
  it('keeps references to other flows as written', () => {
    expect(describeOrigin({
      kind: 'step',
      step: 'sign-in.s2',
      output: 'body./token',
      transform: 'substring',
    }, 'browse', () => 'postApiSession'))
      .toBe('response of sign-in.s2 (postApiSession) at body./token (substring)')
    expect(describeOrigin({ kind: 'browser', note: 'set by page script' }, null, () => null)).toBe('set by the browser: set by page script')
  })
})

describe('clientArguments', () => {
  it('writes the SDK options with a placeholder per input', () => {
    const product = entry('getApiProductsByProductId')
    expect(clientArguments(product, operationInputs(product, shopFlows))).toBe('{ path: { productId } }')
    const session = entry('postApiSession')
    expect(clientArguments(session, operationInputs(session, shopFlows))).toBe('{ body: { username, password }, headers: { "x-csrf-token": xCsrfToken } }')
    const stock = entry('productStock')
    expect(clientArguments(stock, operationInputs(stock, shopFlows))).toBe('{ variables }')
    const store = entry('getStoreInfo')
    expect(clientArguments(store, operationInputs(store, shopFlows))).toBe('{ query: { slug } }')
    const login = entry('getLogin')
    expect(clientArguments(login, operationInputs(login, shopFlows))).toBe('{}')
  })
})

describe('connect methods', () => {
  it('treats only GET-called Connect methods as reads; a descriptor alone is probe\'s business', () => {
    const rpc = (readOnly: boolean, readOnlyEvidence: string | null): Record<string, unknown> => ({
      'x-site-to-api-rpc': {
        protocol: 'connect',
        procedure: 'demo.v1.ItemService/GetItems',
        readOnly,
        readOnlyEvidence,
      },
    })
    const document = OpenApiDocumentSchema.parse({
      openapi: '3.1.0',
      paths: {
        '/demo.v1.ItemService/GetItems': {
          post: {
            operationId: 'postGetItems',
            responses: {},
            ...rpc(true, 'NO_SIDE_EFFECTS in the site\'s descriptor'),
          },
          get: {
            operationId: 'getGetItems',
            responses: {},
            ...rpc(true, 'called with GET'),
          },
        },
      },
    })
    const found = catalogOperations(host, document, [], shopFlows, [])
    expect(found.map(item => [item.operationId, item.rpc?.readOnly])).toEqual([
      ['getGetItems', true],
      ['postGetItems', false],
    ])
  })
})
