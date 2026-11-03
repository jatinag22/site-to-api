/**
 * Pinewood Market's saved shopping lists: a small page apart from the shop, whose actions are
 * guarded by JavaScript dialogs (decision 0059). Deleting a list asks `confirm()` first and only
 * sends `DELETE /api/lists/:id` when it is accepted; renaming asks `prompt()` for the new name and
 * sends it with `POST /api/lists/:id`.
 * Kept out of the shop so the pipeline's outputs do not change with it.
 */
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { readBody, sendHtml, sendJson } from './http'

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Saved lists - Pinewood Market</title></head>
<body>
<h1>Saved lists</h1>
<ul id="lists">
  <li data-id="42"><span class="name">Weekend</span>
    <button type="button" class="rename">Rename</button>
    <button type="button" class="delete">Delete</button></li>
</ul>
<p id="status" role="status"></p>
<script>
  const status = document.getElementById('status')
  const item = document.querySelector('[data-id="42"]')
  item.querySelector('.delete').addEventListener('click', async () => {
    if (!confirm('Delete the list "Weekend"? This cannot be undone.')) {
      status.textContent = 'Kept'
      return
    }
    const response = await fetch('/api/lists/42', { method: 'DELETE' })
    status.textContent = response.ok ? 'Deleted' : 'Failed'
  })
  item.querySelector('.rename').addEventListener('click', async () => {
    const name = prompt('New name for "Weekend"', 'Weekend')
    if (name === null) {
      status.textContent = 'Not renamed'
      return
    }
    const response = await fetch('/api/lists/42', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    item.querySelector('.name').textContent = (await response.json()).name
    status.textContent = 'Renamed'
  })
</script>
</body></html>`

/** A running lists site and what its API received. */
export interface DialogSite {
  origin: string
  /** `METHOD /path` of every API request, in arrival order. */
  apiCalls: string[]
  close: () => Promise<void>
}

/** Starts the lists page on a free port of 127.0.0.1. */
export async function startDialogSite(): Promise<DialogSite> {
  const apiCalls: string[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/lists' && req.method === 'GET') {
      sendHtml(res, 200, PAGE)
      return
    }
    if (url.pathname === '/api/lists/42') {
      apiCalls.push(`${req.method ?? ''} ${url.pathname}`)
      if (req.method === 'DELETE') {
        res.writeHead(204).end()
        return
      }
      if (req.method === 'POST') {
        void readBody(req).then((body) => {
          const parsed: unknown = JSON.parse(body)
          const name = typeof parsed === 'object' && parsed !== null && 'name' in parsed && typeof parsed.name === 'string'
            ? parsed.name
            : 'Weekend'
          sendJson(res, 200, { id: 42, name })
        })
        return
      }
    }
    sendJson(res, 404, { error: 'not_found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('The lists site is not listening on a TCP port.')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    apiCalls,
    close: async () => {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
