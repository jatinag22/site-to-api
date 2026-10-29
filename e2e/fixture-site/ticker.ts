/**
 * `ws://<host>/ws/ticker`: pushes price ticks for the product a client subscribes to, so the
 * capture contains WebSocket frames in both directions.
 */
import type { Buffer } from 'node:buffer'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Catalog } from './catalog'
import { WebSocketServer } from 'ws'
import { parseJson } from './http'

export interface Ticker {
  /** Handles an upgrade for `/ws/ticker`; false for any other path. */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
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

/** The ticker; the server passes it upgrade requests (see {@link Ticker.upgrade}). */
export function createTicker(catalog: Catalog, options: { intervalMs: number, now: () => number }): Ticker {
  const wss = new WebSocketServer({ noServer: true })
  const prices = new Map(catalog.products.map(product => [product.id, product.priceInr]))

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
    upgrade: (req, socket, head) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws/ticker')
        return false
      wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client))
      return true
    },
    close: async () => {
      for (const client of wss.clients)
        client.terminate()
      await new Promise<void>((resolve, reject) => wss.close(error => (error
        ? reject(error)
        : resolve())))
    },
  }
}
