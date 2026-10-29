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

/** One story of {@link storyTable}; `score: null` is a job ad (no score, user or comments). */
export interface Story {
  id: number
  title: string
  url: string
  site: string
  score: number | null
  user: string
  hoursAgo: number
  comments: number
}

/**
 * A news front page laid out like Hacker News: a layout table around a table where each story
 * spans three sibling rows (title row, subtext row, spacer), with vote and hide links built from
 * the story id and a tooltip holding the exact time.
 */
export function storyTable(stories: Story[], page = 1): string {
  const rows = stories.map((story, index) => {
    const rank = (page - 1) * stories.length + index + 1
    const subline = story.score === null
      ? `<span class="age" title="2030-01-0${(index % 9) + 1}T0${story.hoursAgo % 10}:00:00"><a href="item?id=${story.id}">${story.hoursAgo} hours ago</a></span> | <a href="hide?id=${story.id}&amp;goto=news">hide</a>`
      : `<span class="subline"><span class="score" id="score_${story.id}">${story.score} point${story.score === 1
        ? ''
        : 's'}</span> by <a href="user?id=${story.user}" class="hnuser">${story.user}</a> <span class="age" title="2030-01-0${(index % 9) + 1}T0${story.hoursAgo % 10}:00:00"><a href="item?id=${story.id}">${story.hoursAgo} hours ago</a></span> | <a href="hide?id=${story.id}&amp;goto=news">hide</a> | <a href="item?id=${story.id}">${story.comments === 0
        ? 'discuss'
        : `${story.comments}&nbsp;comment${story.comments === 1
          ? ''
          : 's'}`}</a></span>`
    return `<tr class="athing submission" id="${story.id}"><td class="title"><span class="rank">${rank}.</span></td><td class="votelinks"><center><a id="up_${story.id}" href="vote?id=${story.id}&amp;how=up&amp;goto=news"><div class="votearrow" title="upvote"></div></a></center></td><td class="title"><span class="titleline"><a href="${story.url}">${story.title}</a><span class="sitebit comhead"> (<a href="from?site=${story.site}"><span class="sitestr">${story.site}</span></a>)</span></span></td></tr>
<tr><td colspan="2"></td><td class="subtext">${subline}</td></tr>
<tr class="spacer" style="height:5px"></tr>`
  }).join('\n')
  return `<html><head><title>Demo News</title></head><body><center><table id="main">
<tr><td><table><tr><td><b class="name"><a href="news">Demo News</a></b> <a href="newest">new</a> | <a href="ask">ask</a></td></tr></table></td></tr>
<tr id="box"><td><table>
${rows}
<tr class="morespace"></tr><tr><td colspan="2"></td><td class="title"><a href="?p=${page + 1}" class="morelink">More</a></td></tr>
</table></td></tr>
<tr><td><span class="links"><a href="faq">FAQ</a> | <a href="lists">Lists</a></span></td></tr>
</table></center></body></html>`
}

/** A profile laid out like Hacker News: label rows, the date links to a day's archive, then links. */
export function profileTable(user: { name: string, created: string, day: string, karma: number, about: string }): string {
  return `<html><body><center><table id="main">
<tr><td><table><tr><td><a href="news">Demo News</a></td></tr></table></td></tr>
<tr id="box"><td><table>
<tr class="athing"><td valign="top">user:</td><td><a href="user?id=${user.name}" class="hnuser">${user.name}</a></td></tr>
<tr><td valign="top">created:</td><td><span class="age"><a href="front?day=${user.day}&amp;birth=${user.name}">${user.created}</a></span></td></tr>
<tr><td valign="top">karma:</td><td>${user.karma}</td></tr>
<tr><td valign="top">about:</td><td>${user.about}</td></tr>
<tr><td></td><td><a href="submitted?id=${user.name}"><u>submissions</u></a></td></tr>
<tr><td></td><td><a href="threads?id=${user.name}"><u>comments</u></a></td></tr>
</table></td></tr></table></center></body></html>`
}

/** One result of {@link questionList}. */
export interface Question {
  id: number
  title: string
  votes: number
  answers: number
  tag: string
  author: string
}

/**
 * A Q&A list laid out like Stack Overflow: schema.org list items around question cards with
 * utility classes, a stats column, tags and an author card, next to a sidebar of collectives.
 */
export function questionList(questions: Question[], sidebar: string[]): string {
  const cards = questions.map(question => `<div class="bb bc-black-200" itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem">
  <div id="question-summary-${question.id}" class="s-post-summary js-post-summary" data-post-id="${question.id}" itemprop="item" itemscope itemtype="https://schema.org/Question">
    <div class="s-post-summary--stats">
      <div class="s-post-summary--stats-item"><span class="s-post-summary--stats-item-number" itemprop="upvoteCount">${question.votes}</span> <span class="s-post-summary--stats-item-unit">votes</span></div>
      <div class="s-post-summary--stats-item"><span class="s-post-summary--stats-item-number" itemprop="answerCount">${question.answers}</span> <span class="s-post-summary--stats-item-unit">answers</span></div>
    </div>
    <div class="s-post-summary--content">
      <h3 class="s-post-summary--content-title"><a href="/questions/${question.id}/q" class="s-link">${question.title}</a></h3>
      <ul class="tags"><li><a href="/questions/tagged/${question.tag}" class="s-tag post-tag">${question.tag}</a></li></ul>
      <div class="s-user-card"><a href="/users/${question.id + 7}/u" class="author">${question.author}</a></div>
    </div>
  </div>
</div>`).join('\n')
  const side = sidebar.map(name => `<div class="widget-item"><a href="/collectives/${name.toLowerCase()}">${name}</a> <span>A collective</span></div>`).join('')
  return `<html><body><div id="content"><div id="mainbar"><div itemprop="mainEntity" itemscope itemtype="https://schema.org/ItemList">
${cards}
</div></div><div id="sidebar">${side}</div></div></body></html>`
}

/** One card of {@link searchResults}. */
export interface Product {
  code: string
  title: string
  price: string
  rating: string
  sponsored: boolean
}

/**
 * A shop search page laid out like a big marketplace: result cards keyed by `data-code`, with
 * layout classes that differ between sponsored and other cards, next to a filter sidebar with
 * many short links.
 */
export function searchResults(query: string, products: Product[], filters: string[]): string {
  const cards = products.map((product, index) => `<div role="listitem" data-code="${product.code}" data-component-type="search-result" class="col-${product.sponsored ? '4-of-12' : '12-of-12'} result-item">
  <div class="card-wrap"><a class="link-normal" href="/item/${product.code}"><img class="item-image" src="/img/${product.code}.jpg" alt=""></a>
  <h2 class="size-medium"><a class="link-normal" href="/item/${product.code}?q=${query}"><span>${product.title}</span></a></h2>
  <div class="reviews"><span class="icon-alt">${product.rating} out of 5 stars</span></div>
  <span class="item-price"><span class="offscreen">₹${product.price}</span></span>
  <span class="slot" data-pos="${index + 1}"></span></div>
</div>`).join('\n')
  const side = filters.map(name => `<div class="section spacing-none" role="group"><ul><li><a class="nav-link" href="/s?q=${query}&amp;f=${name}"><span class="size-base">${name}</span></a></li></ul></div>`).join('\n')
  return `<html><body><div id="search"><div class="left-nav spacing-double">${side}</div>
<div class="main-slot result-list">${cards}</div></div></body></html>`
}
