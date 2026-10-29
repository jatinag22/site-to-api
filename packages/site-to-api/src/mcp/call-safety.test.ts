/**
 * call_operation against a real generated client (decision 0043): the trust gate, redirects to
 * another origin, and an agent trying to swap the GraphQL document or the dispatcher value.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Handoff } from './handoff'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { shopFlows, writeShopHandoff } from '../../test/handoff'
import { generateClient } from '../gen'
import { UNTRUSTED_CLIENT } from '../trust'
import { createCaller } from './call'
import { loadHandoff } from './handoff'
import { createExplorationServer } from './server'

interface Seen {
  url: string
  body: string
  headers: IncomingMessage['headers']
}

async function listen(handle: (request: IncomingMessage, body: string, response: ServerResponse) => void): Promise<{ server: Server, origin: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => handle(request, Buffer.concat(chunks).toString('utf8'), response))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('test server did not bind to a TCP port')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

describe('call_operation through the generated client', () => {
  const site: Seen[] = []
  const evil: Seen[] = []
  let siteServer: Server
  let evilServer: Server
  let evilOrigin = ''
  let dir = ''
  let handoff: Handoff

  beforeAll(async () => {
    const away = await listen((request, body, response) => {
      evil.push({ url: request.url ?? '', body, headers: request.headers })
      json(response, { stolen: true })
    })
    evilServer = away.server
    // `localhost`, not `127.0.0.1`: another origin on the same machine.
    evilOrigin = away.origin.replace('127.0.0.1', 'localhost')
    const shop = await listen((request, body, response) => {
      site.push({ url: request.url ?? '', body, headers: request.headers })
      const url = new URL(request.url ?? '/', 'http://x')
      if (url.pathname === '/api/products/away') {
        response.writeHead(302, { location: `${evilOrigin}/steal/session-path?token=SECRET` })
        response.end()
        return
      }
      if (url.pathname.startsWith('/api/products/'))
        return json(response, { id: '1007', name: 'Tea', examples: [] })
      if (url.pathname === '/api/graphql') {
        return json(response, {
          data: { stock: 3 },
        })
      }
      if (url.pathname === '/api/store-api')
        return json(response, { name: 'Pinewood' })
      json(response, {})
    })
    siteServer = shop.server
    dir = await writeShopHandoff({ serverUrl: shop.origin })
    await generateClient({ handoffDir: dir, flows: shopFlows })
    handoff = await loadHandoff(dir)
  }, 60_000)

  afterAll(async () => {
    await Promise.all([siteServer, evilServer].map(server => new Promise(resolve => server.close(resolve))))
    await rm(dir, { recursive: true, force: true })
  })

  async function connect(options: { trustClient?: boolean, trustStore?: string, env?: Record<string, string> } = {}): Promise<Client> {
    const caller = createCaller({
      handoff,
      maxRps: 10,
      timeoutMs: 5_000,
      env: options.env ?? {},
      trustClient: options.trustClient,
      trustStore: options.trustStore,
    })
    const server = createExplorationServer({
      load: async () => handoff,
      allowCalls: true,
      unsafeMethods: false,
      maxRps: 10,
      call: async (_handoff, entry, args) => caller(entry, args),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(clientTransport)
    return client
  }

  async function call(client: Client, args: Record<string, unknown>): Promise<{ text: string, error: boolean }> {
    const result = await client.callTool({ name: 'call_operation', arguments: args })
    const first = result.content[0]
    return {
      text: first?.type === 'text'
        ? first.text
        : '',
      error: result.isError === true,
    }
  }

  it('refuses a client this machine did not generate, unless --trust-client', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-other-store-'))
    try {
      const store = path.join(elsewhere, 'trusted-clients')
      site.length = 0
      const refused = await call(await connect({ trustStore: store }), {
        operationId: 'getApiProductsByProductId',
        path: { productId: '1007' },
      })
      expect(refused.error).toBe(true)
      expect(refused.text).toContain(UNTRUSTED_CLIENT)
      expect(site).toEqual([])
      const trusted = await call(await connect({ trustStore: store, trustClient: true }), {
        operationId: 'getApiProductsByProductId',
        path: { productId: '1007' },
      })
      expect(trusted.error).toBe(false)
    }
    finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses a redirect to another origin and sends nothing there, credentials included', async () => {
    evil.length = 0
    const result = await call(await connect({
      env: { SITE_API_COOKIE: 'session=s-1', SITE_API_AUTH: 'key-1' },
    }), {
      operationId: 'getApiProductsByProductId',
      path: { productId: 'away' },
    })
    expect(result.error).toBe(true)
    expect(result.text).toContain(`refused to follow a redirect to another origin (${evilOrigin})`)
    expect(result.text).not.toContain('SECRET')
    expect(result.text).not.toContain('session-path')
    expect(evil).toEqual([])
  })

  it('sends the GraphQL document of the spec, whatever body or query the agent passes', async () => {
    site.length = 0
    const result = await call(await connect(), {
      operationId: 'productStock',
      variables: { id: 7 },
      body: {
        query: 'mutation Evil { deleteEverything }',
        variables: { id: 7 },
      },
      query: { query: 'mutation Evil { deleteEverything }' },
    })
    expect(result.error).toBe(false)
    const sent = site.find(request => request.url.startsWith('/api/graphql'))
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({
      query: 'query ProductStock($id: Int!) { stock(id: $id) }',
      variables: { id: 7 },
    })
    expect(sent?.url).toBe('/api/graphql')
  })

  it('sends the dispatcher value of the spec, whatever value the agent passes', async () => {
    site.length = 0
    const result = await call(await connect(), {
      operationId: 'getStoreInfo',
      query: { slug: 'pinewood', functionName: 'deleteEverything' },
    })
    expect(result.error).toBe(false)
    const sent = new URL(site.find(request => request.url.startsWith('/api/store-api'))?.url ?? '/', 'http://x')
    expect(sent.searchParams.getAll('functionName')).toEqual(['getStoreInfo'])
    expect(sent.searchParams.get('slug')).toBe('pinewood')
  })
})
