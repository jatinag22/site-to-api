import type { Analysis, Flow, Operation } from '../../model'
import type { AgentGuideContext } from './context'
import { describe, expect, it } from 'vitest'
import { withClientState } from './client'
import { hostDocPath } from './host-path'
import { renderHandoffDocs } from './index'

function operation(host: string, operationId: string, init: Partial<Operation> = {}): Operation {
  return {
    host,
    operationId,
    method: 'GET',
    path: `/${operationId}`,
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
    ...init,
  }
}

function flow(id: string, name: string, operationIds: string[], init: Partial<Flow> = {}): Flow {
  return {
    id,
    name,
    trigger: { kind: 'navigate', label: name, pageUrl: 'https://www.big.example/' },
    seenInSessions: 1,
    steps: operationIds.map((operationId, index) => ({
      id: `s${index + 1}`,
      operationId,
      kind: 'api',
      browserOnly: false,
      summary: '',
      sentFrom: null,
      inputs: {
        [`header.x-trace-${index}`]: {
          kind: 'unknown',
          shape: index % 2 === 0
            ? 'UUID'
            : '13 chars',
        },
      },
      outputs: {},
      observedIn: [],
    })),
    ...init,
  }
}

/**
 * A site the size of Binance or IKEA: a first-party API with hundreds of code-only endpoints and
 * untraced inputs, many flows and computed values, and a long tail of third-party hosts.
 */
function bigSite(): Analysis {
  const api = 'api.big.example'
  const www = 'www.big.example'
  const thirdParty = Array.from({ length: 40 }, (_, index) => `t${String(index).padStart(2, '0')}.vendor${index}.example`)
  const operations = [
    operation(www, 'getRoot', { kind: 'page', path: '/' }),
    operation(api, 'postAuthLogin', { method: 'POST', path: '/auth/login' }),
    ...Array.from({ length: 60 }, (_, index) => operation(api, `getThing${index}`)),
    ...Array.from({ length: 300 }, (_, index) => operation(api, `getCodeOnly${index}`, { sourceOnly: true, methodUnknown: index % 3 === 0 })),
    ...thirdParty.map(host => operation(host, `get${host.replace(/\W/g, '')}`)),
  ]
  const flows = [
    ...Array.from({ length: 40 }, (_, index) => flow(`browse-${index}`, `Browse page ${index} ${'with a very long page title '.repeat(6)}`, Array.from({ length: 25 }, (_, step) => `getThing${(index + step) % 60}`))),
    flow('sign-in', 'Sign in', ['postAuthLogin', 'getThing0'], {
      trigger: { kind: 'submit', label: 'Sign in', pageUrl: 'https://www.big.example/login' },
    }),
  ]
  return {
    sessions: ['s1'],
    hosts: [
      ...new Set(operations.map(entry => entry.host)),
    ].sort(),
    botProtection: [],
    excerpts: new Map(),
    warnings: [],
    operations,
    flows: {
      formatVersion: 1,
      generatedBy: 'site-to-api test',
      sessions: ['s1'],
      session: [
        {
          host: api,
          requires: 'browser',
          cookies: [
            { name: 'session', setBy: 'postAuthLogin', source: 'response' },
          ],
          botProtection: [
            {
              vendor: 'Kasada',
              evidence: Array.from({ length: 30 }, (_, index) => `request header x-kpsdk-${index}`).join('; '),
            },
          ],
          probed: false,
        },
        ...thirdParty.map(host => ({
          host,
          requires: 'none' as const,
          cookies: [],
          botProtection: [],
          probed: false,
        })),
      ],
      flows,
      computedValues: Array.from({ length: 50 }, (_, index) => ({
        id: `c${index}`,
        operationId: `getThing${index}`,
        input: 'header.device-info',
        producedBy: {
          file: 'essential.js',
          line: 2,
          column: 1,
          functionName: 'encode',
          original: false,
          excerpt: null,
        },
        calledFrom: null,
        api: 'btoa',
        details: null,
        uses: [],
        evidence: 'transform-hook' as const,
      })),
    },
  }
}

const context: AgentGuideContext = {
  toolVersion: '0.1.0',
  examples: 'masked',
  probed: false,
  client: 'none',
  probe: null,
  pageHosts: [
    {
      host: 'www.big.example',
      requires: 'none',
      cookies: [],
      botProtection: [],
      probed: false,
    },
  ],
}

describe('a large site (decision 0041)', () => {
  const files = new Map(renderHandoffDocs(bigSite(), context))
  const guide = files.get('AGENT.md') ?? ''
  const hostFile = (host: string): string => files.get(hostDocPath(host)) ?? ''

  it('keeps AGENT.md a short index with short lines', () => {
    expect(guide.length).toBeLessThan(25_000)
    expect(Math.max(...guide.split('\n').map(line => line.length))).toBeLessThan(1_000)
  })

  it('writes one file per host and links each from AGENT.md, the site\'s API first', () => {
    const hosts = bigSite().hosts
    for (const host of hosts)
      expect(files.has(hostDocPath(host)), host).toBe(true)
    const hostsSection = guide.slice(guide.indexOf('## Hosts\n'), guide.indexOf('## Key flows'))
    const order = [
      ...hostsSection.matchAll(/^- `([^`]+)`/gm),
    ].map(match => match[1])
    expect(order[0]).toBe('api.big.example')
    expect(order.indexOf('www.big.example')).toBeLessThan(order.indexOf('t00.vendor0.example'))
    expect(hostsSection.indexOf('### The site\'s own hosts')).toBeLessThan(hostsSection.indexOf('### Hosts that served only pages'))
    expect(hostsSection.indexOf('### Hosts that served only pages')).toBeLessThan(hostsSection.indexOf('### Third-party hosts'))
    // 30 hosts get a line; the rest are linked in one line.
    expect(hostsSection).toContain('- 12 more hosts, least important last: [`hosts/t28.vendor28.example.md`](hosts/t28.vendor28.example.md)')
  })

  it('caps the bot-protection evidence in AGENT.md and keeps all of it in the host file', () => {
    expect(guide).toContain('bot protection: Kasada (request header x-kpsdk-0; request header x-kpsdk-1; request header x-kpsdk-2; and 27 more)')
    expect(hostFile('api.big.example')).toContain('request header x-kpsdk-29). Do not try to reproduce it')
  })

  it('lists the session flow first and cuts long flows and names', () => {
    const flows = guide.split('## Key flows')[1]?.split('\n## ')[0] ?? ''
    const items = flows.split('\n').filter(line => line.startsWith('- '))
    expect(items[0]).toBe('- [Sign in](flows.md#sign-in) (submit): `postAuthLogin` → `getThing0`')
    expect(items[1]).toMatch(/^- \[Browse page 0 with a very long page title [^\]]*…\]\(flows\.md#browse-0\) \(navigate\): `getThing0` → .* → … \(19 more steps\)$/)
    expect(items.at(-1)).toBe('- 29 more flows in `flows.md`.')
  })

  it('groups computed values that share a function', () => {
    expect(guide).toContain('- `header.device-info` of 50 operations (`getThing0`, `getThing1`, `getThing2` and 47 more in [`hosts/api.big.example.md`](hosts/api.big.example.md#values-computed-in-the-browser)): `essential.js:2 encode` using `btoa`.')
    expect(hostFile('api.big.example').match(/^- `header\.device-info` of `getThing\d+`/gm)).toHaveLength(50)
  })

  it('groups repetitive gaps in AGENT.md and lists each one in the host file', () => {
    expect(guide).toContain('- 300 operations on `api.big.example` appear only in the site\'s code and were never called during capture (100 with method unknown): `getCodeOnly0`, `getCodeOnly1`, `getCodeOnly2` and 297 more in [`hosts/api.big.example.md`](hosts/api.big.example.md#gaps).')
    expect(guide).toMatch(/^- 1002 request inputs on `api\.big\.example` have no known origin \(most often UUID ×521, 13 chars ×481\)/m)
    const host = hostFile('api.big.example')
    for (let index = 0; index < 300; index++)
      expect(host).toContain(`\`getCodeOnly${index}\``)
    expect(host).toContain('- In flow `sign-in`, 2 inputs have no known origin; a second capture often shows whether they are constant:\n  - `header.x-trace-0` of `postAuthLogin` (UUID)\n  - `header.x-trace-1` of `getThing0` (13 chars)')
  })

  it('names every operation in some host file', () => {
    const all = [...files].filter(([path]) => path.startsWith('hosts/')).map(([, content]) => content).join('\n')
    for (const entry of bigSite().operations)
      expect(all, entry.operationId).toContain(`- \`${entry.operationId}\`: `)
  })

  it('lets gen switch the client state of the compact AGENT.md', () => {
    const current = new Map(renderHandoffDocs(bigSite(), { ...context, client: 'current' })).get('AGENT.md')
    expect(withClientState(guide, 'current')).toBe(current)
    expect(withClientState(current ?? '', 'none')).toBe(guide)
  })

  it('is deterministic', () => {
    expect(renderHandoffDocs(bigSite(), context)).toEqual([...files])
  })
})
