/** Product page: details, reviews on demand and a polled live price. */
import { fetchLivePrice, fetchProduct, fetchRelatedProducts, fetchReviews } from '../api/catalog'
import { formatPrice, requireElement, textElement } from '../format'

async function showReviews(productId: number): Promise<void> {
  const list = requireElement('#reviews', HTMLOListElement)
  const { reviews, averageRating } = await fetchReviews(productId)
  list.replaceChildren(
    textElement('li', `Average rating ${averageRating.toFixed(1)} of 5`),
    ...reviews.map(review => textElement('li', `${review.title} (${review.rating}/5) by ${review.author}: ${review.body}`)),
  )
}

async function showRelatedProducts(productId: number): Promise<void> {
  const list = requireElement('#related', HTMLUListElement)
  const related = await fetchRelatedProducts(productId)
  list.replaceChildren(...related.map((product) => {
    const item = document.createElement('li')
    const link = textElement('a', product.name)
    link.href = `/products/${product.id}`
    item.append(link)
    return item
  }))
}

/** Polls the live price every `intervalMs` while the page is open. */
function startLivePricePolling(productId: number, intervalMs: number): void {
  const target = requireElement('#live-price', HTMLSpanElement)
  const refreshLivePrice = async (): Promise<void> => {
    try {
      const live = await fetchLivePrice(productId)
      target.textContent = `live ${formatPrice(live.priceInr)}`
    }
    catch {
      // A missed poll is not worth interrupting the page for; the next one retries.
      target.textContent = 'live price unavailable'
    }
  }
  setInterval(() => void refreshLivePrice(), intervalMs)
}

export async function renderProductPage(productId: number, pollMs: number): Promise<void> {
  const product = await fetchProduct(productId)
  requireElement('#product-name', HTMLHeadingElement).textContent = product.name
  requireElement('#product-description', HTMLParagraphElement).textContent = product.description
  requireElement('#product-price', HTMLElement).textContent = formatPrice(product.priceInr)
  requireElement('#reviews-button', HTMLButtonElement).addEventListener('click', () => void showReviews(productId))
  requireElement('#related-button', HTMLButtonElement).addEventListener('click', () => void showRelatedProducts(productId))
  startLivePricePolling(productId, pollMs)
}
