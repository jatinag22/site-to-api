/**
 * Live widgets of the product page, over two framed WebSocket protocols:
 * - the stock feed speaks Socket.IO (Engine.IO v4): a long-polling handshake that sends the
 *   live token in the connect packet, then an upgrade to `/socket.io/` over WebSocket and a
 *   `watch` event with an ack;
 * - the basket speaks MessagePack over `/ws/basket`.
 */
import { decode, encode } from './msgpack'

const RS = '\x1E'

function socketBase(): string {
  return `${location.protocol === 'https:'
    ? 'wss'
    : 'ws'}://${location.host}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function liveToken(): Promise<string> {
  const response = await fetch('/api/live-token')
  const body: unknown = await response.json()
  if (!isRecord(body) || typeof body.token !== 'string')
    throw new Error('no live token')
  return body.token
}

/** Opens the Engine.IO session over polling and connects the default namespace with the token. */
async function pollingHandshake(token: string): Promise<string> {
  const base = `/socket.io/?EIO=4&transport=polling`
  const open = await (await fetch(`${base}&t=${Date.now().toString(36)}`)).text()
  const handshake: unknown = JSON.parse(open.slice(1))
  if (!isRecord(handshake) || typeof handshake.sid !== 'string')
    throw new Error('no Engine.IO session')
  const sid = handshake.sid
  await fetch(`${base}&sid=${sid}`, {
    method: 'POST',
    body: `40${JSON.stringify({ token })}`,
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
  })
  const packets = (await (await fetch(`${base}&sid=${sid}`)).text()).split(RS)
  if (!packets.some(packet => packet.startsWith('40{')))
    throw new Error('Socket.IO connect was refused')
  return sid
}

async function connectStockFeed(productId: number, target: HTMLElement): Promise<void> {
  const sid = await pollingHandshake(await liveToken())
  const socket = new WebSocket(`${socketBase()}/socket.io/?EIO=4&transport=websocket&sid=${sid}`)
  socket.addEventListener('open', () => socket.send('2probe'))
  socket.addEventListener('message', (event) => {
    const data = String(event.data)
    if (data === '3probe') {
      socket.send('5')
      socket.send(`421${JSON.stringify([
        'watch',
        { productId },
      ])}`)
    }
    else if (data === '2') {
      socket.send('3')
    }
    else if (data.startsWith('42')) {
      const [name, payload]: unknown[] = JSON.parse(data.slice(2))
      if (name === 'stock' && isRecord(payload))
        target.textContent = `${String(payload.inStock)} in stock (seq ${String(payload.seq)})`
    }
  })
}

function connectBasket(productId: number, target: HTMLElement): void {
  const socket = new WebSocket(`${socketBase()}/ws/basket`)
  socket.binaryType = 'arraybuffer'
  socket.addEventListener('open', () => socket.send(encode({ type: 'hello', productId })))
  socket.addEventListener('message', (event) => {
    if (!(event.data instanceof ArrayBuffer))
      return
    const message = decode(new Uint8Array(event.data))
    if (isRecord(message) && message.type === 'basket')
      target.textContent = `${String(message.items)} items, ₹${String(message.totalInr)}`
  })
}

const stockTarget = document.querySelector<HTMLElement>('#stock-feed')
const basketTarget = document.querySelector<HTMLElement>('#basket')
const product = Number(document.body.dataset.productId)
if (stockTarget !== null && Number.isInteger(product)) {
  connectStockFeed(product, stockTarget).catch((error: unknown) => {
    stockTarget.textContent = `stock feed failed: ${String(error)}`
  })
}
if (basketTarget !== null && Number.isInteger(product))
  connectBasket(product, basketTarget)
