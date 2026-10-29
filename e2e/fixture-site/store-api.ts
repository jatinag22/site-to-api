/**
 * `GET /api/store-api?functionName=...`: a dispatcher endpoint, one URL where a parameter picks
 * the function (like NSE India's `GetQuoteApi`), so the tool's dispatcher split (decision 0039)
 * is exercised end to end. Each function takes its own parameters and answers its own shape:
 *
 * - `getStoreInfo&slug=<store>`: `{ slug, name, address, phone, manager }`.
 * - `getStoreServices`: `{ services: [{ code, label }] }`, no other parameter.
 */
import type { Catalog } from './catalog'
import type { RequestContext } from './http'
import { sendJson } from './http'

const SERVICES = [
  { code: 'click-collect', label: 'Click and collect' },
  { code: 'bakery', label: 'Fresh bakery' },
  { code: 'pharmacy', label: 'Pharmacy counter' },
]

/** The handler of `GET /api/store-api`. */
export function createStoreApi(catalog: Catalog): (ctx: RequestContext) => void {
  return ({ url, res }) => {
    const fn = url.searchParams.get('functionName')
    if (fn === 'getStoreServices') {
      sendJson(res, 200, { services: SERVICES })
      return
    }
    if (fn === 'getStoreInfo') {
      const store = catalog.stores.find(candidate => candidate.slug === url.searchParams.get('slug'))
      if (store === undefined) {
        sendJson(res, 404, { error: 'unknown store' })
        return
      }
      sendJson(res, 200, {
        slug: store.slug,
        name: store.name,
        address: store.address,
        phone: store.phone,
        manager: store.manager,
      })
      return
    }
    sendJson(res, 400, { error: 'unknown functionName' })
  }
}
