/** Account pages: both need the session cookie and the bearer token. */
import { z } from 'zod'
import { getJson } from '../api/client'
import { authorizationHeader } from '../auth/session'
import { formatPrice, requireElement, textElement } from '../format'

const MeSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string(),
})
const OrdersSchema = z.object({
  userId: z.string(),
  orders: z.array(z.object({
    id: z.string(),
    placedAt: z.string(),
    status: z.string(),
    totalInr: z.number(),
    items: z.array(z.object({
      productId: z.number(),
      name: z.string(),
      quantity: z.number(),
      priceInr: z.number(),
    })),
  })),
})

function requireSignedIn(): Record<string, string> | null {
  const header = authorizationHeader()
  if (header === null)
    location.assign('/login')
  return header
}

export async function renderAccountPage(): Promise<void> {
  const auth = requireSignedIn()
  if (auth === null)
    return
  const me = await getJson('/api/me', MeSchema, auth)
  requireElement('#greeting', HTMLHeadingElement).textContent = `Welcome, ${me.displayName}`
  requireElement('#account-email', HTMLParagraphElement).textContent = me.email
}

export async function renderOrdersPage(): Promise<void> {
  const auth = requireSignedIn()
  if (auth === null)
    return
  const { orders } = await getJson('/api/orders', OrdersSchema, auth)
  const body = requireElement('#orders tbody', HTMLTableSectionElement)
  body.replaceChildren(...orders.map((order) => {
    const row = document.createElement('tr')
    row.append(
      textElement('td', order.id),
      textElement('td', order.placedAt.slice(0, 10)),
      textElement('td', order.status),
      textElement('td', formatPrice(order.totalInr)),
    )
    return row
  }))
}
