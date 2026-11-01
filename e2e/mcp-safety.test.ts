/**
 * The generated MCP server (`site-to-api mcp --generated`, decision 0043) against local servers:
 * it never follows a redirect to another origin, so credentials from the environment stay on the
 * site. Needs the built CLI, like the pipeline test.
 */
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { join } from 'pathe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateClient } from '../packages/site-to-api/src/gen'
import { shopFlows, writeShopHandoff } from '../packages/site-to-api/test/handoff'

const here = fileURLToPath(new URL('.', import.meta.url))
const cli = join(here, '..', 'packages', 'site-to-api', 'bin', 'site-to-api.mjs')

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server, origin: string }> {
  const server = createServer(handle)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('test server did not bind to a TCP port')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

function text(result: Pick<CallToolResult, 'content'>): string {
  const first = result.content[0]
  return first?.type === 'text'
    ? first.text
    : ''
}

describe('generated MCP server and redirects', () => {
  const stolen: Array<IncomingMessage['headers']> = []
  let servers: Server[] = []
  let dir = ''
  let evilOrigin = ''

  beforeAll(async () => {
    const evil = await listen((request, response) => {
      stolen.push(request.headers)
      response.end('{}')
    })
    evilOrigin = evil.origin.replace('127.0.0.1', 'localhost')
    const site = await listen((request, response) => {
      if (request.url === '/api/products/away') {
        response.writeHead(302, { location: `${evilOrigin}/steal?token=SECRET` })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: '1007', name: 'Tea', examples: [] }))
    })
    servers = [evil.server, site.server]
    dir = await writeShopHandoff({ serverUrl: site.origin })
    await generateClient({ handoffDir: dir, flows: shopFlows, mcp: 'read' })
  }, 120_000)

  afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses a redirect to another origin and sends nothing there, cookies and auth included', async () => {
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', dir, '--generated'],
      env: {
        ...getDefaultEnvironment(),
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
        SITE_API_COOKIE: 'session=s-1',
        SITE_API_AUTH: 'key-1',
        SITE_API_MAX_RPS: '10',
      },
      // The project root the trust check walks up to (decision 0058).
      cwd: dir,
      stderr: 'ignore',
    }))
    try {
      const ok = await client.callTool({
        name: 'getApiProductsByProductId',
        arguments: {
          path: { productId: '1007' },
        },
      })
      expect(text(ok).split('\n')[0]).toBe('HTTP 200')
      const away = await client.callTool({
        name: 'getApiProductsByProductId',
        arguments: {
          path: { productId: 'away' },
        },
      })
      expect(away.isError).toBe(true)
      expect(text(away)).toContain(`refused to follow a redirect to another origin (${evilOrigin})`)
      expect(text(away)).not.toContain('SECRET')
      expect(stolen).toEqual([])
    }
    finally {
      await client.close()
    }
  }, 60_000)
})
