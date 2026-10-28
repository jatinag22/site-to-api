/**
 * `/api/graphql`: a tiny GraphQL endpoint with no GraphQL library. It knows three operations and
 * answers each the way a real server would, so the tool's GraphQL support (decision 0027) is
 * exercised end to end:
 *
 * - `ProductStock` (query, POST with the document) and `AddToWishlist` (mutation, POST with the
 *   document) share the endpoint, so the tool must split them by operation.
 * - `StoreHours` is an Apollo-style persisted query sent with GET: only `operationName`,
 *   `variables` (JSON) and `extensions.persistedQuery.sha256Hash` travel in the query string.
 */
import type { Catalog } from './catalog'
import type { RequestContext } from './http'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseJson, readBody, sendJson } from './http'

export const PRODUCT_STOCK_DOCUMENT = 'query ProductStock($productId: Int!) { productStock(productId: $productId) { quantity stores } }'
export const ADD_TO_WISHLIST_DOCUMENT = 'mutation AddToWishlist($productId: Int!) { addToWishlist(productId: $productId) { count productIds } }'
/** The document behind the persisted `StoreHours` query; the page only ever sends its hash. */
const STORE_HOURS_DOCUMENT = 'query StoreHours($slug: String!) { storeHours(slug: $slug) { slug hours open } }'
export const STORE_HOURS_HASH = createHash('sha256').update(STORE_HOURS_DOCUMENT).digest('hex')

const PostBodySchema = z.object({
  query: z.string(),
  operationName: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).default({}),
})
const ProductVariablesSchema = z.object({
  productId: z.number().int(),
})
const StoreVariablesSchema = z.object({
  slug: z.string(),
})
const ExtensionsSchema = z.object({
  persistedQuery: z.object({
    version: z.literal(1),
    sha256Hash: z.string(),
  }),
})

/** The name of the operation a document defines, e.g. `ProductStock`. */
function operationNameOf(document: string): string | null {
  return /^\s*(?:query|mutation)\s+(\w+)/.exec(document)?.[1] ?? null
}

function jsonParam(url: URL, name: string): unknown {
  const value = url.searchParams.get(name)
  return value === null
    ? undefined
    : parseJson(value)
}

/** The two handlers of `/api/graphql`; the wishlist lives as long as the server. */
export interface GraphqlEndpoint {
  /** `POST /api/graphql` with `{ query, operationName?, variables }`. */
  post: (ctx: RequestContext) => Promise<void>
  /** `GET /api/graphql?operationName=&variables=<json>&extensions=<json>`: persisted queries only. */
  get: (ctx: RequestContext) => void
}

export function createGraphql(catalog: Catalog): GraphqlEndpoint {
  const wishlist = new Set<number>()
  const productIds = new Set(catalog.products.map(product => product.id))

  const productStock = (variables: unknown): unknown => {
    const parsed = ProductVariablesSchema.safeParse(variables)
    if (!parsed.success || !productIds.has(parsed.data.productId))
      return null
    const { productId } = parsed.data
    const levels = catalog.stores.map(store => store.stock.find(line => line.productId === productId)?.quantity ?? 0)
    return {
      productStock: {
        quantity: levels.reduce((sum, quantity) => sum + quantity, 0),
        stores: levels.filter(quantity => quantity > 0).length,
      },
    }
  }

  const addToWishlist = (variables: unknown): unknown => {
    const parsed = ProductVariablesSchema.safeParse(variables)
    if (!parsed.success || !productIds.has(parsed.data.productId))
      return null
    wishlist.add(parsed.data.productId)
    return {
      addToWishlist: {
        count: wishlist.size,
        productIds: [...wishlist].sort((a, b) => a - b),
      },
    }
  }

  const storeHours = (variables: unknown): unknown => {
    const parsed = StoreVariablesSchema.safeParse(variables)
    const store = parsed.success
      ? catalog.stores.find(candidate => candidate.slug === parsed.data.slug)
      : undefined
    return store === undefined
      ? null
      : {
          storeHours: { slug: store.slug, hours: store.hours, open: true },
        }
  }

  return {
    /** `POST /api/graphql` with `{ query, operationName?, variables }`. */
    async post({ req, res }: RequestContext): Promise<void> {
      const body = PostBodySchema.safeParse(parseJson(await readBody(req)))
      if (!body.success) {
        sendJson(res, 400, {
          errors: [
            { message: 'expected JSON { query, operationName?, variables }' },
          ],
        })
        return
      }
      const name = body.data.operationName ?? operationNameOf(body.data.query)
      const data = name === 'ProductStock' && body.data.query === PRODUCT_STOCK_DOCUMENT
        ? productStock(body.data.variables)
        : name === 'AddToWishlist' && body.data.query === ADD_TO_WISHLIST_DOCUMENT
          ? addToWishlist(body.data.variables)
          : undefined
      if (data === undefined) {
        sendJson(res, 200, {
          errors: [
            { message: `unknown operation ${name ?? '(anonymous)'}` },
          ],
        })
      }
      else if (data === null) {
        sendJson(res, 200, {
          errors: [
            { message: 'invalid variables' },
          ],
        })
      }
      else {
        sendJson(res, 200, { data })
      }
    },

    /** `GET /api/graphql?operationName=&variables=<json>&extensions=<json>`: persisted queries only. */
    get({ res, url }: RequestContext): void {
      const extensions = ExtensionsSchema.safeParse(jsonParam(url, 'extensions'))
      if (!extensions.success || extensions.data.persistedQuery.sha256Hash !== STORE_HOURS_HASH) {
        sendJson(res, 200, {
          errors: [
            { message: 'PersistedQueryNotFound' },
          ],
        })
        return
      }
      const data = storeHours(jsonParam(url, 'variables'))
      sendJson(res, 200, data === null
        ? {
            errors: [
              { message: 'invalid variables' },
            ],
          }
        : { data })
    },
  }
}
