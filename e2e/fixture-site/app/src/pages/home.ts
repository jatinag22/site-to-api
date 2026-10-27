/** Home page: category buttons and a paged product grid, all from the JSON API. */
import type { ProductSummary } from '../api/catalog'
import { fetchCategories, fetchProducts } from '../api/catalog'
import { formatPrice, requireElement, textElement } from '../format'

function renderProductCard(product: ProductSummary): HTMLLIElement {
  const card = document.createElement('li')
  card.className = 'product-card'
  const link = textElement('a', product.name)
  link.href = `/products/${product.id}`
  card.append(link, textElement('p', formatPrice(product.priceInr)))
  return card
}

/** Shows page `page` of `category`, appending to the grid when loading more. */
async function showCategory(category: string, page: number): Promise<void> {
  const grid = requireElement('#product-grid', HTMLUListElement)
  const pager = requireElement('#product-pager', HTMLParagraphElement)
  const result = await fetchProducts(category, page)
  if (page === 1)
    grid.replaceChildren()
  grid.append(...result.items.map(renderProductCard))
  pager.replaceChildren()
  if (result.page < result.totalPages) {
    const more = textElement('button', 'Show more products')
    more.type = 'button'
    more.addEventListener('click', () => void showCategory(category, page + 1))
    pager.append(more)
  }
}

export async function renderHomePage(): Promise<void> {
  const list = requireElement('#category-list', HTMLDivElement)
  const categories = await fetchCategories()
  for (const category of categories) {
    const button = textElement('button', category.name)
    button.type = 'button'
    button.addEventListener('click', () => void showCategory(category.slug, 1))
    list.append(button)
  }
}
