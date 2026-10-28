/**
 * Server-rendered HTML. Most pages are shells the frontend fills from the JSON APIs; `/deals`
 * and `/stores/{slug}` carry their data in the HTML itself so the tool's HTML extraction has
 * tables, label/value pairs and pagination to learn from.
 */
import type { Catalog, Product, Store } from './catalog'
import { DEALS_PAGE_SIZE, formatInr } from './catalog'

/** What every page needs to reference the built frontend. */
export interface PageAssets {
  appScript: string
  analyticsOrigin: string
}

interface LayoutOptions {
  title: string
  page: string
  body: string
  data?: Record<string, string>
  csrfToken?: string
  extraScripts?: string[]
}

/** Escapes text for HTML element content and quoted attribute values. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

function layout(assets: PageAssets, options: LayoutOptions): string {
  const data = Object.entries(options.data ?? {})
    .map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`)
    .join('')
  const csrf = options.csrfToken === undefined
    ? ''
    : `\n<meta name="csrf-token" content="${escapeHtml(options.csrfToken)}">`
  const scripts = [
    '/shield/sensor.js',
    assets.appScript,
    ...(options.extraScripts ?? []),
  ]
    .map(src => `<script defer src="${src}"></script>`)
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} | Pinewood Market</title>
<meta name="analytics-origin" content="${escapeHtml(assets.analyticsOrigin)}">${csrf}
<link rel="stylesheet" href="/assets/site.css">
${scripts}
</head>
<body data-page="${options.page}"${data}>
<header>
<a href="/"><img src="/assets/logo.png" alt="Pinewood Market" width="24" height="24"> Pinewood Market</a>
<nav aria-label="Main">
<a href="/deals?page=1">Deals</a>
<a href="/stores">Stores</a>
<a href="/login">Sign in</a>
</nav>
</header>
<main>
${options.body}
</main>
<footer>
<button type="button" id="price-list-button">Download price list</button>
<span>Pinewood Market is a fictional shop used for testing.</span>
</footer>
</body>
</html>
`
}

/** `GET /`: categories and products are loaded by the frontend. */
export function renderHome(assets: PageAssets): string {
  return layout(assets, {
    title: 'Fresh groceries',
    page: 'home',
    body: `<h1>Shop by category</h1>
<div id="category-list" role="group" aria-label="Categories"></div>
<ul id="product-grid" class="product-grid"></ul>
<p id="product-pager"></p>`,
  })
}

/** `GET /products/{id}`: a shell; details, reviews and live prices come from the APIs. */
export function renderProductShell(assets: PageAssets, product: Product, pollMs: number): string {
  return layout(assets, {
    title: product.name,
    page: 'product',
    data: {
      'product-id': String(product.id),
      'poll-ms': String(pollMs),
    },
    extraScripts: ['/assets/ticker.js'],
    body: `<article id="product">
<h1 id="product-name">Loading…</h1>
<p id="product-description"></p>
<p>Price: <strong id="product-price"></strong> <span id="live-price" aria-live="polite"></span></p>
<p>Stock: <span id="product-stock" aria-live="polite"></span></p>
<p>Ticker: <span id="ticker" aria-live="polite">connecting…</span></p>
<button type="button" id="reviews-button">Read reviews</button>
<button type="button" id="related-button">Similar products</button>
<button type="button" id="wishlist-button">Add to wishlist</button> <span id="wishlist-status" aria-live="polite"></span>
<ol id="reviews"></ol>
<ul id="related" class="product-grid"></ul>
</article>`,
  })
}

/** `GET /deals?page=N`: server-rendered table with pagination links. */
export function renderDeals(assets: PageAssets, catalog: Catalog, page: number): string | null {
  const totalPages = Math.ceil(catalog.deals.length / DEALS_PAGE_SIZE)
  if (!Number.isInteger(page) || page < 1 || page > totalPages)
    return null
  const products = new Map(catalog.products.map(product => [product.id, product]))
  const rows = catalog.deals
    .slice((page - 1) * DEALS_PAGE_SIZE, page * DEALS_PAGE_SIZE)
    .map((deal) => {
      const product = products.get(deal.productId)
      const name = product === undefined
        ? 'Unknown product'
        : product.name
      return `<tr>
<td><a href="/products/${deal.productId}">${escapeHtml(name)}</a></td>
<td class="price">${formatInr(deal.dealPriceInr)}</td>
<td class="discount">${deal.discountPercent}%</td>
</tr>`
    })
    .join('\n')
  const previous = page > 1
    ? `<a href="/deals?page=${page - 1}" rel="prev">Previous page</a>`
    : ''
  const next = page < totalPages
    ? `<a href="/deals?page=${page + 1}" rel="next">Next page</a>`
    : ''
  return layout(assets, {
    title: `Deals, page ${page}`,
    page: 'deals',
    body: `<h1>This week's deals</h1>
<p class="summary">Page ${page} of ${totalPages}</p>
<table class="deals">
<thead><tr><th>Product</th><th>Price</th><th>Discount</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<nav class="pagination" aria-label="Pages">${previous} ${next}</nav>`,
  })
}

/** `GET /stores`: links to every store page. */
export function renderStoreIndex(assets: PageAssets, stores: Store[]): string {
  const items = stores
    .map(store => `<li><a href="/stores/${store.slug}">${escapeHtml(store.name)}</a></li>`)
    .join('\n')
  return layout(assets, {
    title: 'Our stores',
    page: 'stores',
    body: `<h1>Our stores</h1>\n<ul id="store-list">\n${items}\n</ul>`,
  })
}

/** `GET /stores/{slug}`: label/value details as a `<dl>` and as label spans. */
export function renderStore(assets: PageAssets, store: Store): string {
  const yesNo = (value: boolean): string => (value ? 'Yes' : 'No')
  return layout(assets, {
    title: store.name,
    page: 'store',
    data: { store: store.slug },
    body: `<h1 class="store-name">${escapeHtml(store.name)}</h1>
<dl class="store-details">
<dt>Address</dt><dd>${escapeHtml(store.address)}</dd>
<dt>Phone</dt><dd>${escapeHtml(store.phone)}</dd>
<dt>Opening hours</dt><dd>${escapeHtml(store.hours)}</dd>
<dt>Manager</dt><dd>${escapeHtml(store.manager)}</dd>
<dt>Rating</dt><dd>${store.rating.toFixed(1)}</dd>
</dl>
<div class="store-services">
<p><span class="label">Parking</span> <span class="value">${yesNo(store.parking)}</span></p>
<p><span class="label">Pharmacy</span> <span class="value">${yesNo(store.pharmacy)}</span></p>
</div>
<p id="store-hours-live" aria-live="polite"></p>
<h2>In stock at this store</h2>
<ul id="store-stock"></ul>
<p><a href="/stores">All stores</a></p>`,
  })
}

/** `GET /login`: the CSRF token is both in a meta tag and in a hidden input. */
export function renderLogin(assets: PageAssets, csrfToken: string): string {
  return layout(assets, {
    title: 'Sign in',
    page: 'login',
    csrfToken,
    body: `<h1>Sign in</h1>
<form id="login-form" method="post" action="/api/auth/login">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<p><label for="username">Username</label> <input id="username" name="username" autocomplete="username" required></p>
<p><label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="current-password" required></p>
<p><button type="submit">Sign in</button></p>
<p id="login-error" role="alert"></p>
</form>`,
  })
}

/** `GET /account`: filled from `GET /api/me`. */
export function renderAccount(assets: PageAssets): string {
  return layout(assets, {
    title: 'Your account',
    page: 'account',
    body: `<h1 id="greeting">Your account</h1>
<p id="account-email"></p>
<p><a href="/account/orders">My orders</a></p>`,
  })
}

/** `GET /account/orders`: filled from `GET /api/orders`. */
export function renderOrders(assets: PageAssets): string {
  return layout(assets, {
    title: 'Your orders',
    page: 'orders',
    body: `<h1>Your orders</h1>
<table id="orders">
<thead><tr><th>Order</th><th>Placed</th><th>Status</th><th>Total</th></tr></thead>
<tbody></tbody>
</table>`,
  })
}

/** Any unknown page. */
export function renderNotFound(assets: PageAssets): string {
  return layout(assets, {
    title: 'Not found',
    page: 'not-found',
    body: '<h1>Page not found</h1>\n<p><a href="/">Back to the shop</a></p>',
  })
}
