import { z } from 'zod'
/**
 * Store page: remembers the chosen store in a cookie set from JavaScript, which
 * `/api/stock.txt` requires, then shows that store's stock.
 */
import { apiFetch } from '../api/client'
import { fetchStoreHours } from '../api/graphql'
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

/** Both calls go to one dispatcher endpoint, `/api/store-api`; `functionName` picks the function. */
async function showStoreInfo(slug: string): Promise<void> {
  const [info, services] = await Promise.all([
    apiFetch(`/api/store-api?${new URLSearchParams({ functionName: 'getStoreInfo', slug }).toString()}`, {
      headers: { accept: 'application/json' },
    }).then(async response => z.object({
      manager: z.string(),
    }).parse(await response.json())),
    apiFetch(`/api/store-api?${new URLSearchParams({ functionName: 'getStoreServices' }).toString()}`, {
      headers: { accept: 'application/json' },
    }).then(async response => z.object({
      services: z.array(z.object({
        label: z.string(),
      })),
    }).parse(await response.json())),
  ])
  requireElement('#store-info-live', HTMLParagraphElement).textContent = `Manager: ${info.manager}. Services: ${services.services.map(service => service.label).join(', ')}`
}

async function showStoreHours(slug: string): Promise<void> {
  const { hours, open } = await fetchStoreHours(slug)
  requireElement('#store-hours-live', HTMLParagraphElement).textContent = `${open ? 'Open now' : 'Closed'}: ${hours}`
}

export async function renderStorePage(slug: string): Promise<void> {
  rememberStore(slug)
  await Promise.all([
    showStoreHours(slug),
    showStoreStock(),
    showStoreInfo(slug),
  ])
}
