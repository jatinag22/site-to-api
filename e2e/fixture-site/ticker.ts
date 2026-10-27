/**
 * `ws://<host>/ws/ticker`: pushes price ticks for the product a client subscribes to, so the
 * capture contains WebSocket frames in both directions.
 */
import type { Server } from 'node:http'
import type { Catalog } from './catalog'
import { WebSocketServer } from 'ws'
import { parseJson } from './http'

export interface Ticker {
  close: () => Promise<void>
}

/** Price for tick `seq`: walks around the base price in whole paise, never randomly. */
export function tickPrice(basePrice: number, seq: number): number {
  const offset = ((seq * 37) % 41) - 20
  return Math.round(basePrice * 100 + offset * 25) / 100
}

function subscribedProductId(raw: string): number | null {
  const message = parseJson(raw)
  if (typeof message !== 'object' || message === null || !('type' in message) || !('productId' in message))
    return null
  return message.type === 'subscribe' && typeof message.productId === 'number'
    ? message.productId
    : null
}

/** Attaches the ticker to `server`'s upgrade requests for `/ws/ticker`. */
export function attachTicker(server: Server, catalog: Catalog, options: { intervalMs: number, now: () => number }): Ticker {
  const wss = new WebSocketServer({ noServer: true })
  const prices = new Map(catalog.products.map(product => [product.id, product.priceInr]))

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws/ticker') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client))
  })

  wss.on('connection', (client) => {
    let timer: NodeJS.Timeout | undefined
    client.send(JSON.stringify({ type: 'hello', channel: 'prices' }))
    client.on('message', (data) => {
      const productId = subscribedProductId(data.toString())
      const basePrice = productId === null
        ? undefined
        : prices.get(productId)
      if (productId === null || basePrice === undefined) {
        client.send(JSON.stringify({ type: 'error', message: 'send {"type":"subscribe","productId":<id>}' }))
        return
      }
      clearInterval(timer)
      let seq = 0
      timer = setInterval(() => {
        seq += 1
        client.send(JSON.stringify({
          type: 'tick',
          productId,
          seq,
          price: tickPrice(basePrice, seq),
          at: new Date(options.now()).toISOString(),
        }))
      }, options.intervalMs)
    })
    client.on('close', () => clearInterval(timer))
  })

  return {
    close: async () => {
      for (const client of wss.clients)
        client.terminate()
      await new Promise<void>((resolve, reject) => wss.close(error => (error
        ? reject(error)
        : resolve())))
    },
  }
}
