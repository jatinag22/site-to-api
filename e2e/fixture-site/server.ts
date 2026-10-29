/**
 * The "Pinewood Market" fixture website: a fictional grocery shop that exercises every feature
 * of site-to-api (JSON APIs, login with an encrypted password, toy bot protection, HTML and text
 * data, a JavaScript-set cookie, WebSocket, analytics noise on a second origin and static
 * assets). End-to-end tests run the tool against it so they never touch real websites.
 * `e2e/README.md` lists every endpoint and the tool feature it exercises.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { User } from './auth'
import type { Catalog, Product } from './catalog'
import type { RequestContext } from './http'
import type { PageAssets } from './pages'
import type { StaticFile } from './static'
import { createServer } from 'node:http'
import { z } from 'zod'
import { createAuth } from './auth'
import { buildFrontend } from './bundle'
import { createCatalog, PRODUCTS_PAGE_SIZE } from './catalog'
import { createGraphql } from './graphql'
import { parseCookies, parseJson, readBody, send, sendHtml, sendJson, serializeCookie } from './http'
import {
  renderAccount,
  renderDeals,
  renderHome,
  renderLogin,
  renderNotFound,
  renderOrders,
  renderProductShell,
  renderStore,
  renderStoreIndex,
} from './pages'
import { createShield } from './shield'
import { PIXEL_GIF, STATIC_FILES } from './static'
import { createStoreApi } from './store-api'
import { attachTicker, tickPrice } from './ticker'

export interface FixtureSiteOptions {
  /** Port of the main origin (`http://localhost:<port>`). 0 or omitted picks a free port. */
  port?: number
  /** Port of the analytics origin (`http://127.0.0.1:<port>`). 0 or omitted picks a free port. */
  secondaryPort?: number
  /** Seed for every generated value. The same seed serves the same data. */
  seed?: number
  /** Clock used for tokens and timestamps. Pass a fixed function for reproducible output. */
  now?: () => number
  /** How often the product page polls `/api/live-price`. */
  livePriceIntervalMs?: number
  /** How often `/ws/ticker` pushes a tick. */
  tickIntervalMs?: number
}

export interface FixtureSite {
  /** Main origin, e.g. `http://localhost:51234`. */
  origin: string
  /** Analytics origin on a different host, e.g. `http://127.0.0.1:51235`. */
  secondaryOrigin: string
  close: () => Promise<void>
}

/** Default seed, so a bare `startFixtureSite()` always serves the same catalogue. */
const DEFAULT_SEED = 20261028

const SESSION_COOKIE = 'pm_session'
const STORE_COOKIE = 'pm_store'

const LoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})
const SensorBodySchema = z.object({
  sensor_data: z.string().min(1),
})

type Handler = (ctx: RequestContext, params: string[]) => void | Promise<void>

interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  handler: Handler
}

function productSummary(product: Product): Record<string, unknown> {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    unit: product.unit,
    priceInr: product.priceInr,
    rating: product.rating,
    inStock: product.inStock,
  }
}

function csvCell(value: string | number | boolean): string {
  const text = String(value)
  return /[",\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('fixture site: server has no TCP address')
  return (address satisfies AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => (error
    ? reject(error)
    : resolve())))
}

function createRoutes(deps: {
  catalog: Catalog
  assets: PageAssets
  auth: ReturnType<typeof createAuth>
  shield: ReturnType<typeof createShield>
  now: () => number
  livePriceIntervalMs: number
}): Route[] {
  const { catalog, assets, auth, shield, now } = deps
  const graphql = createGraphql(catalog)
  const storeApi = createStoreApi(catalog)
  const productsById = new Map(catalog.products.map(product => [product.id, product]))
  const livePriceSeq = new Map<number, number>()

  /** HTML pages also set `bm_sz`, as the real product's edge does. */
  const page = (res: ServerResponse, html: string | null): void => {
    const cookie = serializeCookie('bm_sz', shield.issueBmSz(), { maxAgeSeconds: 14_400 })
    if (html === null)
      sendHtml(res, 404, renderNotFound(assets), { 'set-cookie': cookie })
    else
      sendHtml(res, 200, html, { 'set-cookie': cookie })
  }

  const findProduct = (id: string | undefined): Product | undefined => productsById.get(Number(id))

  const requireUser = (ctx: RequestContext): User | null => {
    const user = auth.authenticate(ctx.cookies.get(SESSION_COOKIE), ctx.req.headers.authorization)
    if (user === null)
      sendJson(ctx.res, 401, { error: 'unauthorized', message: 'send the pm_session cookie and Authorization: Bearer <token>' })
    return user
  }

  return [
    {
      method: 'GET',
      pattern: /^\/$/,
      handler: ({ res }) => page(res, renderHome(assets)),
    },
    {
      method: 'GET',
      pattern: /^\/products\/(\d+)$/,
      handler: ({ res }, [id]) => {
        const product = findProduct(id)
        page(res, product === undefined
          ? null
          : renderProductShell(assets, product, deps.livePriceIntervalMs))
      },
    },
    {
      method: 'GET',
      pattern: /^\/deals$/,
      handler: ({ res, url }) => page(res, renderDeals(assets, catalog, Number(url.searchParams.get('page') ?? '1'))),
    },
    {
      method: 'GET',
      pattern: /^\/stores$/,
      handler: ({ res }) => page(res, renderStoreIndex(assets, catalog.stores)),
    },
    {
      method: 'GET',
      pattern: /^\/stores\/([a-z-]+)$/,
      handler: ({ res }, [slug]) => {
        const store = catalog.stores.find(candidate => candidate.slug === slug)
        page(res, store === undefined
          ? null
          : renderStore(assets, store))
      },
    },
    {
      method: 'GET',
      pattern: /^\/login$/,
      handler: ({ res }) => page(res, renderLogin(assets, auth.issueCsrfToken())),
    },
    {
      method: 'GET',
      pattern: /^\/account$/,
      handler: ({ res }) => page(res, renderAccount(assets)),
    },
    {
      method: 'GET',
      pattern: /^\/account\/orders$/,
      handler: ({ res }) => page(res, renderOrders(assets)),
    },

    {
      method: 'POST',
      pattern: /^\/shield\/collect$/,
      handler: async ({ req, res }) => {
        const body = SensorBodySchema.safeParse(parseJson(await readBody(req)))
        if (!body.success) {
          sendJson(res, 400, { success: false })
          return
        }
        sendJson(res, 201, { success: true }, {
          'set-cookie': serializeCookie('_abck', shield.issueAbck(), { maxAgeSeconds: 31_536_000 }),
        })
      },
    },

    {
      method: 'POST',
      pattern: /^\/api\/graphql$/,
      handler: ctx => graphql.post(ctx),
    },
    {
      method: 'GET',
      pattern: /^\/api\/graphql$/,
      handler: ctx => graphql.get(ctx),
    },
    {
      method: 'GET',
      pattern: /^\/api\/store-api$/,
      handler: ctx => storeApi(ctx),
    },
    {
      method: 'GET',
      pattern: /^\/api\/categories$/,
      handler: ({ res }) => sendJson(res, 200, catalog.categories.map(category => ({
        slug: category.slug,
        name: category.name,
        productCount: catalog.products.filter(product => product.category === category.slug).length,
      }))),
    },
    {
      method: 'GET',
      pattern: /^\/api\/products$/,
      handler: ({ res, url }) => {
        const category = url.searchParams.get('category')
        const pageNumber = Number(url.searchParams.get('page') ?? '1')
        const matching = catalog.products.filter(product => category === null || category === '' || product.category === category)
        const totalPages = Math.max(1, Math.ceil(matching.length / PRODUCTS_PAGE_SIZE))
        if (!Number.isInteger(pageNumber) || pageNumber < 1) {
          sendJson(res, 400, { error: 'bad_request', message: 'page must be a positive integer' })
          return
        }
        sendJson(res, 200, {
          items: matching.slice((pageNumber - 1) * PRODUCTS_PAGE_SIZE, pageNumber * PRODUCTS_PAGE_SIZE).map(productSummary),
          page: pageNumber,
          pageSize: PRODUCTS_PAGE_SIZE,
          total: matching.length,
          totalPages,
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/products\/(\d+)$/,
      handler: ({ res }, [id]) => {
        const product = findProduct(id)
        if (product === undefined) {
          sendJson(res, 404, { error: 'not_found', message: `no product ${id ?? ''}` })
        }
        else {
          sendJson(res, 200, {
            ...productSummary(product),
            mrpInr: product.mrpInr,
            description: product.description,
          })
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/products\/(\d+)\/reviews$/,
      handler: ({ res }, [id]) => {
        const product = findProduct(id)
        const reviews = product === undefined
          ? undefined
          : catalog.reviews.get(product.id)
        if (product === undefined || reviews === undefined) {
          sendJson(res, 404, { error: 'not_found', message: `no product ${id ?? ''}` })
          return
        }
        const average = reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
        sendJson(res, 200, { productId: product.id, averageRating: Math.round(average * 10) / 10, reviews })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/products\/(\d+)\/related$/,
      handler: ({ res }, [id]) => {
        const product = findProduct(id)
        if (product === undefined) {
          sendJson(res, 404, { error: 'not_found', message: `no product ${id ?? ''}` })
          return
        }
        const items = catalog.products
          .filter(other => other.category === product.category && other.id !== product.id)
          .slice(0, 3)
          .map(productSummary)
        sendJson(res, 200, { productId: product.id, items })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/live-price$/,
      handler: ({ res, url }) => {
        const product = findProduct(url.searchParams.get('productId') ?? undefined)
        if (product === undefined) {
          sendJson(res, 400, { error: 'bad_request', message: 'productId must be a known product id' })
          return
        }
        const seq = (livePriceSeq.get(product.id) ?? 0) + 1
        livePriceSeq.set(product.id, seq)
        sendJson(res, 200, {
          productId: product.id,
          priceInr: tickPrice(product.priceInr, seq),
          currency: 'INR',
          seq,
          asOf: new Date(now()).toISOString(),
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/export\.csv$/,
      handler: ({ res }) => {
        const lines = ['id,sku,name,category,price_inr,in_stock']
        for (const product of catalog.products) {
          lines.push([
            product.id,
            product.sku,
            product.name,
            product.category,
            product.priceInr.toFixed(2),
            product.inStock,
          ].map(csvCell).join(','))
        }
        send(res, 200, 'text/csv; charset=utf-8', `${lines.join('\n')}\n`, {
          'content-disposition': 'attachment; filename="pinewood-price-list.csv"',
          'cache-control': 'no-store',
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/stock\.txt$/,
      handler: ({ res, cookies }) => {
        const store = catalog.stores.find(candidate => candidate.slug === cookies.get(STORE_COOKIE))
        if (store === undefined) {
          send(res, 400, 'text/plain; charset=utf-8', `choose a store first (the ${STORE_COOKIE} cookie is missing or unknown)\n`)
          return
        }
        const lines = store.stock.map(({ productId, quantity }) => {
          const name = productsById.get(productId)?.name ?? 'unknown'
          return `${productId}|${name}|${quantity > 0
            ? 'in-stock'
            : 'sold-out'}|${quantity}`
        })
        send(res, 200, 'text/plain; charset=utf-8', `${lines.join('\n')}\n`, { 'cache-control': 'no-store' })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/auth\/key$/,
      handler: ({ res }) => sendJson(res, 200, { keyId: auth.keyId, algorithm: 'RSA-OAEP-256', publicKey: auth.publicKeySpki }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/auth\/login$/,
      handler: async ({ req, res }) => {
        const csrf = req.headers['x-csrf-token']
        if (!auth.verifyCsrfToken(typeof csrf === 'string'
          ? csrf
          : undefined)) {
          sendJson(res, 403, { error: 'csrf', message: 'missing or invalid x-csrf-token header' })
          return
        }
        const body = LoginBodySchema.safeParse(parseJson(await readBody(req)))
        if (!body.success) {
          sendJson(res, 400, { error: 'bad_request', message: 'expected JSON { username, password }' })
          return
        }
        const result = auth.login(body.data.username, body.data.password)
        if (!result.ok) {
          sendJson(res, result.status, { error: 'login_failed', message: result.error })
          return
        }
        sendJson(res, 200, {
          token: result.token,
          tokenType: 'Bearer',
          expiresIn: 3600,
          user: result.user,
        }, {
          'set-cookie': serializeCookie(SESSION_COOKIE, result.sessionId, { httpOnly: true }),
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/me$/,
      handler: (ctx) => {
        const user = requireUser(ctx)
        if (user !== null)
          sendJson(ctx.res, 200, user)
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/orders$/,
      handler: (ctx) => {
        const user = requireUser(ctx)
        if (user !== null)
          sendJson(ctx.res, 200, { userId: user.id, orders: catalog.orders })
      },
    },
  ]
}

function createMainHandler(routes: Route[], files: ReadonlyMap<string, StaticFile>, shield: ReturnType<typeof createShield>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const ctx: RequestContext = {
      req,
      res,
      url,
      cookies: parseCookies(req.headers.cookie),
    }

    const file = req.method === 'GET'
      ? files.get(url.pathname)
      : undefined
    if (file !== undefined) {
      send(res, 200, file.contentType, file.body, { 'cache-control': 'public, max-age=3600' })
      return
    }

    // Every API call needs the cookie the shield issues, like a site behind bot protection.
    if (url.pathname.startsWith('/api/') && !shield.isValidAbck(ctx.cookies.get('_abck'))) {
      sendJson(res, 403, { error: 'blocked', message: 'missing or invalid _abck cookie' })
      return
    }

    let pathMatched = false
    for (const route of routes) {
      const match = route.pattern.exec(url.pathname)
      if (match === null)
        continue
      pathMatched = true
      if (route.method === req.method) {
        await route.handler(ctx, match.slice(1))
        return
      }
    }
    if (pathMatched)
      sendJson(res, 405, { error: 'method_not_allowed' })
    else if (url.pathname.startsWith('/api/'))
      sendJson(res, 404, { error: 'not_found' })
    else
      sendHtml(res, 404, '<!doctype html><title>Not found</title><h1>Not found</h1>')
  }
}

/** The analytics origin: a beacon endpoint and a tracking pixel, both pure noise. */
function handleAnalytics(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (req.method === 'POST' && path === '/collect') {
    // Drain the beacon body; its contents are never used.
    req.resume()
    req.on('end', () => {
      res.writeHead(204, { 'access-control-allow-origin': '*' })
      res.end()
    })
    return
  }
  if (req.method === 'GET' && path === '/pixel.gif') {
    send(res, 200, 'image/gif', PIXEL_GIF, { 'cache-control': 'no-store' })
    return
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found\n')
}

/**
 * Starts both origins and builds the frontend. Resolves once both servers accept connections.
 *
 * @example
 * const site = await startFixtureSite()
 * await page.goto(site.origin)
 * await site.close()
 */
export async function startFixtureSite(options: FixtureSiteOptions = {}): Promise<FixtureSite> {
  const seed = options.seed ?? DEFAULT_SEED
  const now = options.now ?? Date.now
  const catalog = createCatalog(seed)
  const auth = createAuth({ seed, now })
  const shield = createShield(seed)
  const bundle = await buildFrontend()

  const analytics = createServer(handleAnalytics)
  const secondaryPort = await listen(analytics, options.secondaryPort ?? 0)
  const secondaryOrigin = `http://127.0.0.1:${secondaryPort}`

  const assets: PageAssets = { appScript: bundle.appScript, analyticsOrigin: secondaryOrigin }
  const files = new Map([
    ...STATIC_FILES,
    ...bundle.files,
  ])
  const routes = createRoutes({
    catalog,
    assets,
    auth,
    shield,
    now,
    livePriceIntervalMs: options.livePriceIntervalMs ?? 1500,
  })
  const handle = createMainHandler(routes, files, shield)

  const main = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // A handler bug must fail loudly in tests, not hang the browser.
      const message = error instanceof Error
        ? error.message
        : String(error)
      if (res.headersSent)
        res.destroy()
      else
        sendJson(res, 500, { error: 'internal', message })
    })
  })
  const ticker = attachTicker(main, catalog, { intervalMs: options.tickIntervalMs ?? 1000, now })
  let port: number
  try {
    port = await listen(main, options.port ?? 0)
  }
  catch (error) {
    await closeServer(analytics)
    throw error
  }

  return {
    origin: `http://localhost:${port}`,
    secondaryOrigin,
    close: async () => {
      await ticker.close()
      await Promise.all([
        closeServer(main),
        closeServer(analytics),
      ])
    },
  }
}
