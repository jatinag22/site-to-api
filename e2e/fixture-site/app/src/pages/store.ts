/**
 * Store page: remembers the chosen store in a cookie set from JavaScript, which
 * `/api/stock.txt` requires, then shows that store's stock.
 */
import { apiFetch } from '../api/client'
import { requireElement, textElement } from '../format'

interface StockLine {
  productId: number
  name: string
  status: string
  quantity: number
}

/** Sets `pm_store`; no server response ever sets this cookie. */
function rememberStore(slug: string): void {
  document.cookie = `pm_store=${encodeURIComponent(slug)}; path=/; SameSite=Lax`
}

/** Parses `id|name|status|quantity` lines. */
function parseStockLines(text: string): StockLine[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line) => {
      const [id = '', name = '', status = '', quantity = '0'] = line.split('|')
      return {
        productId: Number(id),
        name,
        status,
        quantity: Number(quantity),
      }
    })
}

async function showStoreStock(): Promise<void> {
  const list = requireElement('#store-stock', HTMLUListElement)
  const response = await apiFetch('/api/stock.txt', {
    headers: { accept: 'text/plain' },
  })
  const lines = parseStockLines(await response.text())
  list.replaceChildren(...lines.map(line => textElement('li', `${line.name}: ${line.status === 'in-stock'
    ? `${line.quantity} left`
    : 'sold out'}`)))
}

export async function renderStorePage(slug: string): Promise<void> {
  rememberStore(slug)
  await showStoreStock()
}
