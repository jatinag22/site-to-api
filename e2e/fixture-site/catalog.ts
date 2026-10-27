/**
 * The fictional "Pinewood Market" catalogue: categories, products, reviews, stores, deals and
 * the demo user's orders. Everything is generated from a seed so two sites started with the same
 * seed serve byte-identical data, while different pages, ids and slugs still return different
 * values (the analysis needs samples that vary).
 */
import { createRng } from './random'

interface Category {
  slug: string
  name: string
  code: string
}

export interface Product {
  id: number
  sku: string
  name: string
  category: string
  unit: string
  priceInr: number
  mrpInr: number
  rating: number
  inStock: boolean
  description: string
}

interface Review {
  id: string
  productId: number
  author: string
  rating: number
  title: string
  body: string
  createdAt: string
}

export interface Store {
  slug: string
  name: string
  address: string
  phone: string
  hours: string
  manager: string
  rating: number
  parking: boolean
  pharmacy: boolean
  stock: Array<{ productId: number, quantity: number }>
}

interface Deal {
  productId: number
  dealPriceInr: number
  discountPercent: number
}

interface Order {
  id: string
  placedAt: string
  status: 'delivered' | 'shipped' | 'processing'
  totalInr: number
  items: Array<{ productId: number, name: string, quantity: number, priceInr: number }>
}

export interface Catalog {
  categories: Category[]
  products: Product[]
  reviews: Map<number, Review[]>
  stores: Store[]
  deals: Deal[]
  orders: Order[]
}

const CATEGORIES: Category[] = [
  { slug: 'pantry', name: 'Pantry', code: 'PAN' },
  { slug: 'snacks', name: 'Snacks', code: 'SNK' },
  { slug: 'beverages', name: 'Beverages', code: 'BEV' },
  { slug: 'household', name: 'Household', code: 'HSE' },
]

const PRODUCT_NAMES: Record<string, string[]> = {
  pantry: [
    'Rolled Oats',
    'Basmati Rice',
    'Toor Dal',
    'Cold Pressed Groundnut Oil',
    'Whole Wheat Atta',
    'Rock Salt',
  ],
  snacks: [
    'Roasted Peanuts',
    'Masala Makhana',
    'Baked Ragi Chips',
    'Trail Mix',
    'Jaggery Chikki',
    'Salted Cashews',
  ],
  beverages: [
    'Assam Tea Leaves',
    'Filter Coffee Powder',
    'Kokum Cooler',
    'Green Tea Bags',
    'Cold Brew Concentrate',
    'Lemongrass Infusion',
  ],
  household: [
    'Dishwash Gel',
    'Bamboo Scrub Pads',
    'Floor Cleaner',
    'Cotton Kitchen Towels',
    'Laundry Liquid',
    'Glass Jar Set',
  ],
}

const UNITS = [
  '250 g',
  '500 g',
  '1 kg',
  '2 kg',
  '1 l',
  'pack of 3',
]
const REVIEWERS = [
  'Asha',
  'Rohan',
  'Meera',
  'Kabir',
  'Nila',
  'Dev',
  'Tara',
  'Ishan',
]
const REVIEW_TITLES = [
  'Good value',
  'Fresh and tasty',
  'Will buy again',
  'Decent quality',
  'Packaging could be better',
  'Family favourite',
]
const REVIEW_BODIES = [
  'Arrived well packed and on time.',
  'Tastes exactly like the one from the local store.',
  'Slightly pricey but the quality is consistent.',
  'Good for everyday use.',
  'The pack size is perfect for two people.',
]

const STORE_SEEDS = [
  { slug: 'pine-hill', name: 'Pine Hill', street: '12 Ridge Road' },
  { slug: 'cedar-park', name: 'Cedar Park', street: '48 Lakeview Lane' },
  { slug: 'maple-cross', name: 'Maple Cross', street: '7 Market Square' },
  { slug: 'birch-lane', name: 'Birch Lane', street: '230 Old Mill Street' },
]
const MANAGERS = [
  'R. Iyer',
  'S. Menon',
  'P. Khanna',
  'A. Bose',
]

/** Day 0 for generated dates. Fixed so dates in reviews and orders never depend on the clock. */
const BASE_DATE_MS = Date.UTC(2026, 0, 1)
const DAY_MS = 86_400_000
const PRODUCTS_PER_CATEGORY = 6

function roundRupees(value: number): number {
  return Math.round(value * 100) / 100
}

/** Builds the whole catalogue from `seed`. */
export function createCatalog(seed: number): Catalog {
  const rng = createRng(seed)
  const products: Product[] = []
  let nextId = 1001

  for (const category of CATEGORIES) {
    for (const baseName of PRODUCT_NAMES[category.slug] ?? []) {
      const id = nextId++
      const unit = rng.pick(UNITS)
      // Some prices above ₹1,000 so formatted prices contain thousands separators.
      const priceInr = roundRupees(rng.int(49, 2499) + rng.pick([0, 0.5, 0.99]))
      products.push({
        id,
        sku: `PM-${category.code}-${id}`,
        name: `${baseName} ${unit}`,
        category: category.slug,
        unit,
        priceInr,
        mrpInr: roundRupees(priceInr * (1 + rng.int(5, 30) / 100)),
        rating: rng.int(30, 50) / 10,
        inStock: rng.next() > 0.15,
        description: `${baseName} from the Pinewood Market house range, packed as ${unit}.`,
      })
    }
  }

  const reviews = new Map<number, Review[]>()
  let reviewNumber = 1
  for (const product of products) {
    const count = rng.int(2, 5)
    const list: Review[] = []
    for (let i = 0; i < count; i++) {
      list.push({
        id: `rv_${String(reviewNumber++).padStart(5, '0')}`,
        productId: product.id,
        author: rng.pick(REVIEWERS),
        rating: rng.int(2, 5),
        title: rng.pick(REVIEW_TITLES),
        body: rng.pick(REVIEW_BODIES),
        createdAt: new Date(BASE_DATE_MS + rng.int(0, 280) * DAY_MS).toISOString(),
      })
    }
    reviews.set(product.id, list)
  }

  const stores: Store[] = STORE_SEEDS.map((store, index) => ({
    slug: store.slug,
    name: `Pinewood Market ${store.name}`,
    address: `${store.street}, ${store.name}, Bengaluru 5600${String(10 + index * 7)}`,
    phone: `+91 80 0000 ${String(1000 + rng.int(0, 8999))}`,
    hours: `${rng.pick(['7:00', '7:30', '8:00'])} to ${rng.pick(['21:00', '22:00', '22:30'])}`,
    manager: MANAGERS[index] ?? 'Store manager',
    rating: rng.int(36, 49) / 10,
    parking: rng.next() > 0.4,
    pharmacy: rng.next() > 0.5,
    stock: products
      .filter(() => rng.next() > 0.35)
      .map(product => ({
        productId: product.id,
        quantity: rng.int(0, 60),
      })),
  }))

  const deals: Deal[] = products
    .filter((_, index) => index % 4 !== 3)
    .map((product) => {
      const discountPercent = rng.pick([5, 10, 15, 20, 25, 30, 40])
      return {
        productId: product.id,
        discountPercent,
        dealPriceInr: roundRupees(product.priceInr * (1 - discountPercent / 100)),
      }
    })

  const orders: Order[] = [0, 1, 2].map((index) => {
    const items = [0, 1, 2].slice(0, rng.int(1, 3)).map(() => {
      const product = rng.pick(products)
      return {
        productId: product.id,
        name: product.name,
        quantity: rng.int(1, 4),
        priceInr: product.priceInr,
      }
    })
    return {
      id: `PM-${String(240_000 + index * 137 + rng.int(0, 99))}`,
      placedAt: new Date(BASE_DATE_MS + (200 + index * 30) * DAY_MS).toISOString(),
      status: (['delivered', 'shipped', 'processing'] as const)[index] ?? 'processing',
      totalInr: roundRupees(items.reduce((sum, item) => sum + item.priceInr * item.quantity, 0)),
      items,
    }
  })

  return {
    categories: CATEGORIES,
    products,
    reviews,
    stores,
    deals,
    orders,
  }
}

/** Products shown per page by `GET /api/products`. Small so each category has two pages. */
export const PRODUCTS_PAGE_SIZE = PRODUCTS_PER_CATEGORY / 2

/** Deals shown per page on `/deals`. */
export const DEALS_PAGE_SIZE = 6

/** Formats rupees the way the site's HTML does, e.g. `₹1,299.00`. */
export function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(value)
}
