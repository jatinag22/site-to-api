import type { Analysis, Operation } from '../../model'
import { describe, expect, it } from 'vitest'
import { hostStems } from '../host-files'
import { asyncApiFileName, specFileName } from '../openapi'
import { handoffStems, hostDocPath, hostLinker } from './host-path'
import { renderHandoffDocs } from './index'

function operation(host: string, operationId: string): Operation {
  return {
    host,
    operationId,
    method: 'GET',
    path: '/',
    kind: 'api',
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses: [],
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges: [],
  }
}

function analysisOf(hosts: string[]): Analysis {
  return {
    sessions: ['s'],
    hosts: [...hosts].sort(),
    botProtection: [],
    excerpts: new Map(),
    warnings: [],
    operations: hosts.map((host, index) => operation(host, `op${index}`)),
    flows: {
      formatVersion: 1,
      generatedBy: 'test',
      sessions: ['s'],
      session: [],
      flows: [],
      computedValues: [],
    },
  }
}

describe('host file stems', () => {
  it('keeps the sanitized name of a host that clashes with no other', () => {
    const stems = hostStems(['localhost:4173', 'api.example.com'])
    expect(hostDocPath('localhost:4173', stems)).toBe('hosts/localhost_4173.md')
    expect(specFileName('localhost:4173', stems)).toBe('localhost_4173.yaml')
    expect(asyncApiFileName('api.example.com', stems)).toBe('api.example.com.asyncapi.yaml')
  })

  it('gives hosts with the same sanitized name different stems', () => {
    for (const pair of [
      ['a.com:1', 'a.com_1'],
      ['[::1]:80', '_::1_:80'],
      ['[::1]:80', '__1_:80'],
      ['A.com', 'a.com'],
    ]) {
      const stems = hostStems(pair)
      const values = pair.map(host => stems.get(host) ?? '')
      expect(new Set(values.map(value => value.toLowerCase())).size, pair.join(' / ')).toBe(2)
      for (const value of values)
        expect(value).toMatch(/^[\w.-]+$/)
    }
  })

  it('lets a host spelled like the stem keep it and suffixes the other with its hash', () => {
    const stems = hostStems(['a.com:1', 'a.com_1'])
    expect(stems.get('a.com_1')).toBe('a.com_1')
    expect(stems.get('a.com:1')).toBe('a.com_1-b2c6cea8')
  })

  it('depends only on the set of hosts, not their order', () => {
    const hosts = [
      'a.com:1',
      'a.com_1',
      'b.test',
      '[::1]:80',
      '_::1_:80',
    ]
    expect([
      ...hostStems(hosts),
    ].sort()).toEqual([
      ...hostStems([...hosts].reverse()),
    ].sort())
  })

  it('writes one file per host and links each from AGENT.md when names clash', () => {
    const analysis = analysisOf([
      'a.com:1',
      'a.com_1',
      '[::1]:80',
      '_::1_:80',
    ])
    const context = {
      toolVersion: '0',
      examples: 'masked',
      probed: false,
      client: 'none',
      probe: null,
    } as const
    const files = renderHandoffDocs(analysis, context)
    const hostFiles = files.filter(([path]) => path.startsWith('hosts/'))
    expect(hostFiles).toHaveLength(4)
    expect(new Set(hostFiles.map(([path]) => path)).size).toBe(4)
    const stems = handoffStems(analysis)
    const link = hostLinker(stems)
    const guide = files.find(([path]) => path === 'AGENT.md')?.[1] ?? ''
    for (const host of analysis.hosts) {
      expect(guide, host).toContain(link(host))
      const own = files.find(([path]) => path === hostDocPath(host, stems))?.[1] ?? ''
      // Each file is about its own host and names its own spec.
      expect(own.split('\n')[0], host).toContain(host.replace(/[[\]_]/g, char => `\\${char}`))
      expect(own, host).toContain(`\`specs/${specFileName(host, stems)}\``)
    }
  })
})
