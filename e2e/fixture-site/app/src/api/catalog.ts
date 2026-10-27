/** Catalogue endpoints of the shop API. */
import { z } from 'zod'
import { getJson } from './client'

const ProductSummarySchema = z.object({
  id: z.number(),
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  unit: z.string(),
  priceInr: z.number(),
  rating: z.number(),
  inStock: z.boolean(),
})
export type ProductSummary = z.infer<typeof ProductSummarySchema>

const ProductSchema = ProductSummarySchema.extend({
  mrpInr: z.number(),
  description: z.string(),
})
export type Product = z.infer<typeof ProductSchema>

const CategorySchema = z.object({
  slug: z.string(),
  name: z.string(),
  productCount: z.number(),
})
export type Category = z.infer<typeof CategorySchema>

const ProductPageSchema = z.object({
  items: z.array(ProductSummarySchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
})
export type ProductPage = z.infer<typeof ProductPageSchema>

const ReviewSchema = z.object({
  id: z.string(),
  author: z.string(),
  rating: z.number(),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
})

const ReviewsSchema = z.object({
  productId: z.number(),
  averageRating: z.number(),
  reviews: z.array(ReviewSchema),
})
const RelatedSchema = z.object({
  productId: z.number(),
  items: z.array(ProductSummarySchema),
})
const LivePriceSchema = z.object({
  productId: z.number(),
  priceInr: z.number(),
  currency: z.string(),
  seq: z.number(),
  asOf: z.string(),
})
export type LivePrice = z.infer<typeof LivePriceSchema>

export async function fetchCategories(): Promise<Category[]> {
  return getJson('/api/categories', z.array(CategorySchema))
}

export async function fetchProducts(category: string, page: number): Promise<ProductPage> {
  const query = new URLSearchParams({
    category,
    page: String(page),
  })
  return getJson(`/api/products?${query.toString()}`, ProductPageSchema)
}

export async function fetchProduct(productId: number): Promise<Product> {
  return getJson(`/api/products/${productId}`, ProductSchema)
}

export async function fetchReviews(productId: number): Promise<z.infer<typeof ReviewsSchema>> {
  return getJson(`/api/products/${productId}/reviews`, ReviewsSchema)
}

/** Only called from the "Similar products" button, which the e2e scenarios never press. */
export async function fetchRelatedProducts(productId: number): Promise<ProductSummary[]> {
  const related = await getJson(`/api/products/${productId}/related`, RelatedSchema)
  return related.items
}

export async function fetchLivePrice(productId: number): Promise<LivePrice> {
  return getJson(`/api/live-price?productId=${productId}`, LivePriceSchema)
}
