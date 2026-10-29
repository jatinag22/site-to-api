import type { CallArguments, CallOutcome } from './call'
import type { OperationEntry } from './catalog'
import type { Handoff } from './handoff'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { writeShopHandoff } from '../../test/handoff'
import { loadHandoff } from './handoff'
import { createExplorationServer } from './server'
import { createHandoffSource } from './source'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

interface Session {
  client: Client
  handoff: Handoff
  calls: Array<{ operationId: string, args: CallArguments }>
}

async function open(options: { examples?: 'masked' | 'raw' | 'none' | null, allowCalls?: boolean, unsafeMethods?: boolean, client?: boolean } = {}): Promise<Session> {
  const dir = await writeShopHandoff({ examples: options.examples })
  dirs.push(dir)
  const loaded = await loadHandoff(dir)
  // The calls are recorded instead of sent; call.test.ts covers the real client.
  const handoff = { ...loaded, clientGenerated: options.client ?? true }
  const calls: Session['calls'] = []
  const call = async (_handoff: Handoff, entry: OperationEntry, args: CallArguments): Promise<CallOutcome> => {
    calls.push({ operationId: entry.operationId, args })
    return {
      status: 200,
      ok: true,
      contentType: 'application/json',
      data: { ok: true },
    }
  }
  const server = createExplorationServer({
    load: async () => handoff,
    allowCalls: options.allowCalls ?? false,
    unsafeMethods: options.unsafeMethods ?? false,
    maxRps: 1,
    call,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, handoff, calls }
}

async function callText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string, error: boolean }> {
  const result = await client.callTool({ name, arguments: args })
  const first = result.content[0]
  return {
    text: first?.type === 'text'
      ? first.text
      : '',
    error: result.isError === true,
  }
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { text, error } = await callText(client, name, args)
  if (error)
    throw new Error(text)
  return JSON.parse(text)
}

describe('exploration server', () => {
  it('lists the read-only tools, and call_operation only with --allow-calls', async () => {
    const plain = await open()
    const tools = (await plain.client.listTools()).tools
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'get_examples',
      'get_flow',
      'get_operation',
      'get_source',
      'list_hosts',
      'search_operations',
    ])
    for (const tool of tools)
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    const calling = await open({ allowCalls: true })
    expect((await calling.client.listTools()).tools.map(tool => tool.name)).toContain('call_operation')
  })

  it('describes hosts, session needs, flows and computed values', async () => {
    const { client } = await open()
    expect(await callJson(client, 'list_hosts')).toMatchObject({
      handoff: { sessions: 2, examples: 'masked', client: 'generated' },
      calls: { enabled: false },
      hosts: [
        {
          host: 'shop.example.com',
          spec: 'specs/shop.example.com.yaml',
          operations: 9,
          byKind: { 'api': 7, 'page': 1, 'bot-protection': 1 },
          session: { requires: 'cookies' },
        },
      ],
      flows: [
        { id: 'sign-in', trigger: 'submit Sign in', steps: 2 },
        { id: 'browse' },
      ],
      computedValues: [
        { id: 'c1', operationId: 'postApiSession', api: 'crypto.subtle.encrypt' },
      ],
    })
  })

  it('searches with paging', async () => {
    const { client } = await open()
    expect(await callJson(client, 'search_operations', { query: 'products', limit: 2 })).toMatchObject({
      total: 3,
      items: [
        { operationId: 'getApiProductsByProductId', changesData: false },
        { operationId: 'productStock', graphql: 'query ProductStock' },
      ],
      nextOffset: 2,
    })
    expect(await callJson(client, 'search_operations', { kind: 'bot-protection' })).toMatchObject({
      total: 1,
      items: [
        { operationId: 'postShieldCollect' },
      ],
    })
  })

  it('returns one operation without examples, with inputs, session needs and the client call', async () => {
    const { client } = await open()
    const text = (await callText(client, 'get_operation', { operationId: 'postApiSession' })).text
    expect(text).not.toContain('redacted')
    expect(text).not.toContain('example1')
    expect(JSON.parse(text)).toMatchObject({
      operationId: 'postApiSession',
      changesData: true,
      call: {
        allowed: false,
        reason: expect.stringContaining('--allow-calls'),
      },
      spec: { file: 'specs/shop.example.com.yaml', method: 'post' },
      inputs: [
        {
          location: 'header.x-csrf-token',
          from: expect.stringContaining('sign-in.s1 (getLogin)'),
        },
        {},
        {},
        {},
      ],
      session: {
        host: { requires: 'cookies' },
        probeFound: 'not worked out by probe',
      },
      client: {
        sdkFunction: 'postApiSession',
        call: expect.stringContaining('sdk.postApiSession({ body:'),
      },
      flowSteps: [
        { step: 'sign-in.s2', flow: 'Sign in' },
      ],
      computedValues: [
        { id: 'c1' },
      ],
    })
    const shield = await callJson(client, 'get_operation', { operationId: 'postShieldCollect' })
    expect(shield).toMatchObject({ client: null })
  })

  it('reports an unknown operation as a tool error that says what to do', async () => {
    const { client } = await open()
    const result = await callText(client, 'get_operation', { operationId: 'nope' })
    expect(result).toMatchObject({
      error: true,
      text: expect.stringContaining('search_operations'),
    })
  })

  it('returns a flow with each step\'s request', async () => {
    const { client } = await open()
    expect(await callJson(client, 'get_flow', { flowId: 'sign-in' })).toMatchObject({
      steps: [
        { id: 's1', method: 'GET', path: '/login' },
        { id: 's2', method: 'POST', path: '/api/session' },
      ],
      computedValues: [
        { id: 'c1' },
      ],
    })
    expect(await callText(client, 'get_flow', { flowId: 'x' })).toMatchObject({
      error: true,
      text: expect.stringContaining('sign-in, browse'),
    })
  })

  it('serves masked examples, none for --examples none, and refuses raw or unknown ones', async () => {
    const masked = await open()
    expect(await callJson(masked.client, 'get_examples', { operationId: 'postApiSession' })).toMatchObject({
      examples: 'masked',
      parameters: [
        {
          location: 'header.x-csrf-token',
          examples: ['<redacted: 40 hex chars>'],
        },
      ],
      requestBody: {
        'application/json': [
          { username: 'xxxx' },
        ],
      },
    })
    const none = await open({ examples: 'none' })
    expect(await callJson(none.client, 'get_examples', { operationId: 'getLogin' })).toMatchObject({ examples: 'none' })
    const raw = await open({ examples: 'raw' })
    expect(await callText(raw.client, 'get_examples', { operationId: 'postApiSession' })).toMatchObject({
      error: true,
      text: expect.stringContaining('--examples raw'),
    })
    const unknown = await open({ examples: null })
    expect(await callText(unknown.client, 'get_examples', { operationId: 'postApiSession' })).toMatchObject({
      error: true,
      text: expect.stringContaining('build.json'),
    })
  })

  it('serves only excerpts in source/, by path or by operation', async () => {
    const { client } = await open()
    expect(await callJson(client, 'get_source', { path: 'source/src/auth/crypto.L18-28.ts.md' })).toMatchObject({
      text: expect.stringContaining('encryptPassword'),
    })
    expect(await callJson(client, 'get_source', { operationId: 'postApiSession' })).toMatchObject({
      excerpts: [
        { path: 'source/src/auth/crypto.L18-28.ts.md' },
      ],
    })
    for (const path of [
      'secret.txt',
      'source/../secret.txt',
      '../flows.json',
      '/etc/passwd',
      'flows.json',
    ])
      expect((await callText(client, 'get_source', { path })).error, path).toBe(true)
  })
})

describe('call_operation', () => {
  it('sends reads with the agent\'s options and refuses writes, bot protection and state changes', async () => {
    const { client, calls } = await open({ allowCalls: true })
    expect(await callJson(client, 'call_operation', {
      operationId: 'getApiProductsByProductId',
      path: { productId: '1007' },
    })).toMatchObject({ status: 200, ok: true })
    expect(calls).toEqual([
      {
        operationId: 'getApiProductsByProductId',
        args: {
          path: { productId: '1007' },
        },
      },
    ])
    for (const [operationId, reason] of [
      ['postApiSession', '--unsafe-methods'],
      ['addToWishlist', 'GraphQL mutation'],
      ['postShieldCollect', 'bot-protection'],
      ['getApiLogout', 'changes state'],
      ['getApiProductsByProductIdRelated', 'code only'],
    ] as const) {
      expect(await callText(client, 'call_operation', { operationId }), operationId).toMatchObject({
        error: true,
        text: expect.stringContaining(reason),
      })
    }
    expect(calls).toHaveLength(1)
  })

  it('sends writes only with --unsafe-methods, and still never bot protection', async () => {
    const { client, calls } = await open({ allowCalls: true, unsafeMethods: true })
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'call_operation')
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    await callJson(client, 'call_operation', {
      operationId: 'addToWishlist',
      variables: { id: 1 },
    })
    expect(calls).toEqual([
      {
        operationId: 'addToWishlist',
        args: {
          variables: { id: 1 },
        },
      },
    ])
    expect((await callText(client, 'call_operation', { operationId: 'postShieldCollect' })).error).toBe(true)
  })

  it('asks for gen when the folder has no client', async () => {
    const { client } = await open({ allowCalls: true, client: false })
    expect(await callText(client, 'call_operation', { operationId: 'getLogin' })).toMatchObject({
      error: true,
      text: expect.stringContaining('site-to-api gen'),
    })
  })
})

describe('without a handoff folder', () => {
  it('starts, answers every tool with what to run, and picks the folder up once build wrote it', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'site-to-api-mcp-empty-'))
    dirs.push(parent)
    const dir = path.join(parent, 'api-handoff')
    const server = createExplorationServer({
      load: createHandoffSource(dir),
      allowCalls: true,
      unsafeMethods: false,
      maxRps: 1,
      call: async () => ({ status: 200, ok: true, contentType: null }),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(clientTransport)
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    expect(tools).toHaveLength(7)
    for (const [name, args] of [
      ['list_hosts', {}],
      ['search_operations', {}],
      [
        'get_operation',
        { operationId: 'getLogin' },
      ],
      [
        'get_flow',
        { flowId: 'sign-in' },
      ],
      [
        'get_examples',
        { operationId: 'getLogin' },
      ],
      [
        'get_source',
        { operationId: 'getLogin' },
      ],
      [
        'call_operation',
        { operationId: 'getLogin' },
      ],
    ] as const) {
      expect(await callText(client, name, args), name).toEqual({
        error: true,
        text: expect.stringMatching(/^No handoff folder at .*api-handoff: run `site-to-api capture` \(browse the site\), then `site-to-api build`/),
      })
    }
    // build writes the folder later; the same server serves it.
    await cp(await writeShopHandoff(), dir, { recursive: true })
    expect(await callJson(client, 'search_operations', { query: 'session' })).toMatchObject({ total: 1 })
  })
})
