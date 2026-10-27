/**
 * Hand-written pages shaped like real sites (navigation, footers, framework attributes), used by
 * the html stage's tests. No real site was copied and every value is made up.
 */

function page(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title} | Demo Bazaar</title>
  <link rel="stylesheet" href="/static/app.css">
  <script src="/static/runtime.js"></script>
</head>
<body class="theme-light">
  <header class="site-header">
    <a class="logo" href="/">Demo Bazaar</a>
    <nav class="main-nav">
      <ul>
        <li><a href="/c/kitchen">Kitchen</a></li>
        <li><a href="/c/garden">Garden</a></li>
        <li><a href="/c/toys">Toys</a></li>
      </ul>
    </nav>
  </header>
  <main id="content">
${main}
  </main>
  <footer class="site-footer"><p>Prices include GST. <a href="/help">Help</a></p></footer>
</body>
</html>`
}

/** One row of {@link productTable}. */
export interface ProductRow {
  id: number
  slug: string
  name: string
  price: string
  stock: string
  listed: string
}

/** A category listing: products in a table with a header row, prices in rupees, links with ids. */
export function productTable(category: string, rows: ProductRow[]): string {
  const body = rows.map(row => `        <tr data-sku="SKU-${row.id}">
          <td class="name"><a href="/products/${row.id}-${row.slug}">${row.name}</a></td>
          <td class="price">₹${row.price}</td>
          <td>${row.stock}</td>
          <td>${row.listed}</td>
        </tr>`).join('\n')
  return page(category, `    <h1>${category}</h1>
    <table id="products" class="listing">
      <thead><tr><th>Product</th><th>Price</th><th>In stock</th><th>Listed on</th></tr></thead>
      <tbody>
${body}
      </tbody>
    </table>
    <p class="count">${rows.length} products</p>`)
}

/** The values shown by {@link productDetail}. */
export interface ProductDetail {
  name: string
  brand: string
  price: string
  inStock: 'Yes' | 'No'
  seller: string
  rating: string
  sku: string
}

/** A product page with a definition list, a two-column spec table and a "Label: value" line. */
export function productDetail(product: ProductDetail): string {
  return page(product.name, `    <div class="product">
      <h1 class="product-title">${product.name}</h1>
      <dl class="specs">
        <dt>Brand</dt><dd>${product.brand}</dd>
        <dt>Price</dt><dd>₹${product.price}</dd>
        <dt>Available</dt><dd>${product.inStock}</dd>
      </dl>
      <table class="seller-info">
        <tr><th>Seller</th><td>${product.seller}</td></tr>
        <tr><th>Rating</th><td>${product.rating} / 5</td></tr>
      </table>
      <p class="sku">SKU: ${product.sku}</p>
      <button class="buy">Add to cart</button>
    </div>`)
}

/** One card of {@link cardGrid}; `badge: null` leaves the badge out. */
export interface Card {
  id: number
  title: string
  price: string
  badge: string | null
}

/** A search result grid of cards; the badge is missing on some cards. */
export function cardGrid(query: string, cards: Card[]): string {
  const items = cards.map(card => `      <article class="card" data-id="${card.id}">
        <img class="card-image" src="/img/${card.id}.jpg" alt="">
        <h3 class="card-title"><a href="/p/${card.id}">${card.title}</a></h3>
        <span class="card-price">$${card.price}</span>
        ${card.badge === null
          ? ''
          : `<span class="badge">${card.badge}</span>`}
        <button class="add">Add to cart</button>
      </article>`).join('\n')
  return page(`Search: ${query}`, `    <h2 class="results-title">Results for "${query}"</h2>
    <section class="grid">
${items}
    </section>`)
}

/** A sign-in page carrying a CSRF token twice: in a meta tag and in a hidden form field. */
export function signInPage(token: string, formToken: string): string {
  return page('Sign in', `    <meta name="csrf-token" content="${token}">
    <form class="sign-in" method="post" action="/session">
      <input type="hidden" name="_token" value="${formToken}">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <button type="submit">Sign in</button>
    </form>
    <p class="note">Your order ID: ORD-${formToken.slice(0, 6)} was saved.</p>`)
}

/** A Next.js-style page with state in `__NEXT_DATA__` and in an inline assignment. */
export function nextDataPage(apiKey: string, userId: string): string {
  return page('Account', `    <div id="__next"><div class="account">Loading…</div></div>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"config":{"apiKey":"${apiKey}","region":"in"}}},"page":"/account","buildId":"b1"}</script>
    <script>window.__INITIAL_STATE__ = {"user":{"id":"${userId}","plan":"free"}};</script>`)
}
