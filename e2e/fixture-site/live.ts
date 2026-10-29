/**
 * Two framed WebSocket endpoints with no WebSocket library beyond `ws`, so the capture holds
 * protocols the tool must decode (decision 0038):
 * - `/socket.io/`: hand-rolled Engine.IO v4 frames, long-polling handshake first
 *   (`0{"sid":…}`, then `40{"token":…}` posted and `40{"sid":…}` polled), then the WebSocket
 *   upgrade (`2probe`/`3probe`, `5`), a `watch` event with ack id 1 answered by `431[…]`, `stock`
 *   events, and one server ping;
 * - `/ws/basket`: binary MessagePack frames in both directions.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket } from 'ws'
import type { Catalog } from './catalog'
import type { RequestContext } from './http'
import type { Rng } from './random'
import { Buffer } from 'node:buffer'
import { WebSocketServer } from 'ws'
import { decode, encode } from './app/src/widgets/msgpack'
import { readBody, send, sendJson } from './http'

const RS = '\x1E'

export interface LiveEndpoints {
  /** `GET /api/live-token`: the token the stock feed's connect packet carries. */
  token: (ctx: RequestContext) => void
  /** `GET` and `POST /socket.io/` with `transport=polling`. */
  polling: (ctx: RequestContext) => Promise<void>
  /** Handles an upgrade for its paths; false for any other path. */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
  close: () => Promise<void>
}

interface EngineSession {
  token: string | null
  queue: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createLiveEndpoints(catalog: Catalog, rng: Rng, options: { intervalMs: number }): LiveEndpoints {
  const tokens = new Set<string>()
  const sessions = new Map<string, EngineSession>()
  const wss = new WebSocketServer({ noServer: true })
  const stock = new Map(catalog.products.map(product => [
    product.id,
    product.inStock
      ? 12
      : 0,
  ]))
  const timers = new Set<NodeJS.Timeout>()

  function polling(ctx: RequestContext): Promise<void> {
    const { url, req, res } = ctx
    if (url.searchParams.get('EIO') !== '4' || url.searchParams.get('transport') !== 'polling') {
      sendJson(res, 400, { code: 0, message: 'Transport unknown' })
      return Promise.resolve()
    }
    const sid = url.searchParams.get('sid')
    if (sid === null) {
      const fresh = rng.hex(10)
      sessions.set(fresh, { token: null, queue: [] })
      send(res, 200, 'text/plain; charset=UTF-8', `0${JSON.stringify({
        sid: fresh,
        upgrades: ['websocket'],
        pingInterval: 25000,
        pingTimeout: 20000,
        maxPayload: 1000000,
      })}`)
      return Promise.resolve()
    }
    const session = sessions.get(sid)
    if (session === undefined) {
      sendJson(res, 400, { code: 1, message: 'Session ID unknown' })
      return Promise.resolve()
    }
    if (req.method === 'POST') {
      return readBody(req).then((body) => {
        for (const packet of body.split(RS)) {
          if (!packet.startsWith('40'))
            continue
          const auth: unknown = JSON.parse(packet.slice(2) || '{}')
          const token = isRecord(auth) && typeof auth.token === 'string'
            ? auth.token
            : null
          if (token !== null && tokens.has(token)) {
            session.token = token
            session.queue.push(`40${JSON.stringify({
              sid: rng.hex(10),
            })}`)
          }
          else {
            session.queue.push(`44${JSON.stringify({ message: 'invalid token' })}`)
          }
        }
        send(res, 200, 'text/html', 'ok')
      })
    }
    const packets = session.queue.splice(0)
    send(res, 200, 'text/plain; charset=UTF-8', packets.length === 0
      ? '6'
      : packets.join(RS))
    return Promise.resolve()
  }

  function stockFeed(client: WebSocket, session: EngineSession): void {
    let timer: NodeJS.Timeout | undefined
    let seq = 0
    client.on('message', (data) => {
      const text = String(data)
      if (text === '2probe') {
        client.send('3probe')
        return
      }
      const watch = /^42(\d+)(\[.*\])$/.exec(text)
      if (watch === null || session.token === null)
        return
      const [, ackId, json = '[]'] = watch
      const [name, payload]: unknown[] = JSON.parse(json)
      const productId = isRecord(payload) && typeof payload.productId === 'number'
        ? payload.productId
        : null
      if (name !== 'watch' || productId === null || !stock.has(productId))
        return
      client.send(`43${ackId}${JSON.stringify([
        { ok: true, productId },
      ])}`)
      clearInterval(timer)
      timer = setInterval(() => {
        seq += 1
        client.send(`42${JSON.stringify([
          'stock',
          { productId, inStock: (stock.get(productId) ?? 0) + (seq % 3), seq },
        ])}`)
        if (seq === 2)
          client.send('2')
      }, options.intervalMs)
      timers.add(timer)
    })
    client.on('close', () => clearInterval(timer))
  }

  function basket(client: WebSocket): void {
    client.on('message', (data, isBinary) => {
      if (!isBinary || !(data instanceof Buffer))
        return
      const message = decode(new Uint8Array(data))
      if (!isRecord(message) || message.type !== 'hello' || typeof message.productId !== 'number')
        return
      const product = catalog.products.find(item => item.id === message.productId)
      if (product === undefined)
        return
      for (const items of [1, 2]) {
        client.send(encode({
          type: 'basket',
          productId: product.id,
          items,
          totalInr: Math.round(product.priceInr * items * 100) / 100,
        }))
      }
    })
  }

  return {
    token: (ctx) => {
      const token = `lt_${rng.hex(16)}`
      tokens.add(token)
      sendJson(ctx.res, 200, { token })
    },
    polling,
    upgrade: (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/ws/basket') {
        wss.handleUpgrade(req, socket, head, basket)
        return true
      }
      if (url.pathname !== '/socket.io/')
        return false
      const session = sessions.get(url.searchParams.get('sid') ?? '')
      if (url.searchParams.get('transport') !== 'websocket' || session === undefined) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return true
      }
      wss.handleUpgrade(req, socket, head, client => stockFeed(client, session))
      return true
    },
    close: async () => {
      for (const timer of timers)
        clearInterval(timer)
      for (const client of wss.clients)
        client.terminate()
      await new Promise<void>((resolve, reject) => wss.close(error => (error
        ? reject(error)
        : resolve())))
    },
  }
}
