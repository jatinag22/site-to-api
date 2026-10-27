/** Price ticker widget for product pages, fed by the `/ws/ticker` WebSocket. */

interface Tick {
  type: 'tick'
  productId: number
  seq: number
  price: number
}

function isTick(value: unknown): value is Tick {
  return typeof value === 'object' && value !== null
    && 'type' in value && value.type === 'tick'
    && 'price' in value && typeof value.price === 'number'
    && 'seq' in value && typeof value.seq === 'number'
}

function renderTick(target: HTMLElement, tick: Tick): void {
  target.textContent = `₹${tick.price.toFixed(2)} (tick ${tick.seq})`
}

/** Opens the ticker socket and subscribes to `productId`. */
function connectPriceTicker(productId: number, target: HTMLElement): WebSocket {
  const scheme = location.protocol === 'https:'
    ? 'wss'
    : 'ws'
  const socket = new WebSocket(`${scheme}://${location.host}/ws/ticker`)
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'subscribe', productId }))
  })
  socket.addEventListener('message', (event) => {
    const message: unknown = typeof event.data === 'string'
      ? JSON.parse(event.data)
      : null
    if (isTick(message))
      renderTick(target, message)
  })
  return socket
}

const tickerTarget = document.querySelector<HTMLElement>('#ticker')
const tickerProduct = Number(document.body.dataset.productId)
if (tickerTarget !== null && Number.isInteger(tickerProduct))
  connectPriceTicker(tickerProduct, tickerTarget)
