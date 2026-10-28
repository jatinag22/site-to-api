/**
 * GraphQL calls of the shop, all to `/api/graphql`: a query and a mutation that send their
 * documents, and an Apollo-style persisted query sent with GET that ships only its hash.
 */
import { z } from 'zod'
import { apiFetch } from './client'

const PRODUCT_STOCK = 'query ProductStock($productId: Int!) { productStock(productId: $productId) { quantity stores } }'
const ADD_TO_WISHLIST = 'mutation AddToWishlist($productId: Int!) { addToWishlist(productId: $productId) { count productIds } }'

/** A persisted query: the server knows the document, the page sends the hash. */
const STORE_HOURS = {
  name: 'StoreHours',
  type: 'query',
  sha256Hash: 'b0030133ece2ce57bffc72f52e4153e3fd1d78aec5330bbf11d7935a03abcc4b',
}

const ErrorsSchema = z.array(z.object({
  message: z.string(),
})).optional()

function dataOf<T extends z.ZodType>(json: unknown, schema: T): z.output<T> {
  const result = z.object({
    data: schema.optional(),
    errors: ErrorsSchema,
  }).parse(json)
  if (result.data === undefined)
    throw new Error(result.errors?.map(error => error.message).join('; ') ?? 'GraphQL response without data')
  return result.data
}

async function post<T extends z.ZodType>(query: string, variables: Record<string, unknown>, schema: T): Promise<z.output<T>> {
  const response = await apiFetch('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  return dataOf(await response.json(), schema)
}

export async function fetchProductStock(productId: number): Promise<{ quantity: number, stores: number }> {
  const data = await post(PRODUCT_STOCK, { productId }, z.object({
    productStock: z.object({
      quantity: z.number(),
      stores: z.number(),
    }),
  }))
  return data.productStock
}

export async function addToWishlist(productId: number): Promise<number> {
  const data = await post(ADD_TO_WISHLIST, { productId }, z.object({
    addToWishlist: z.object({
      count: z.number(),
      productIds: z.array(z.number()),
    }),
  }))
  return data.addToWishlist.count
}

export async function fetchStoreHours(slug: string): Promise<{ hours: string, open: boolean }> {
  const query = new URLSearchParams({
    operationName: STORE_HOURS.name,
    variables: JSON.stringify({ slug }),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: STORE_HOURS.sha256Hash },
    }),
  })
  const response = await apiFetch(`/api/graphql?${query.toString()}`, {
    headers: { accept: 'application/json' },
  })
  const data = dataOf(await response.json(), z.object({
    storeHours: z.object({
      slug: z.string(),
      hours: z.string(),
      open: z.boolean(),
    }),
  }))
  return data.storeHours
}
