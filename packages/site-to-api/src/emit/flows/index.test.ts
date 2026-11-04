import type { FlowsDocument } from '../../model'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOSTILE, injected, renderMarkdown } from '../../../test/markdown'
import { fakeHtmlLocator, fakeSourceResolver, SECRET_VALUES, shopCapture } from '../../../test/scenarios'
import { API, twoHostAnalysis, WWW } from '../../../test/two-hosts'
import { traceValues } from '../../analyze/correlate'
import { buildFlows } from '../../analyze/flows'
import { createRedactor } from '../../analyze/redact'
import { SiteToApiError } from '../../errors'
import { FlowsDocumentSchema } from '../../model'
import { renderFlowsMarkdown, writeFlows } from './index'

const capture = shopCapture()
const sessions = capture.sessions.map(entry => entry.session)
const doc: FlowsDocument = buildFlows({
  exchanges: capture.exchanges,
  operations: capture.operations,
  sessions,
  traces: traceValues({
    exchanges: capture.exchanges,
    sessions,
    htmlLocator: fakeHtmlLocator,
    staticStrings: new Set(),
    minValueLength: 4,
  }),
  sourceResolver: fakeSourceResolver,
  botProtection: capture.botProtection,
  redactor: createRedactor({
    exchanges: capture.exchanges,
    config: {
      examples: 'masked',
      maxExamples: 3,
      patterns: [],
      fields: [],
    },
  }),
  toolVersion: '1.2.3',
})

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-flows-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFlows', () => {
  it('writes flows.json, flows.schema.json and flows.md', async () => {
    const written = await writeFlows(join(dir, 'out'), doc, { operations: capture.operations })
    expect(written).toEqual(['flows.json', 'flows.schema.json', 'flows.md'].map(name => join(dir, 'out', name)))
    const json: unknown = JSON.parse(await readFile(join(dir, 'out', 'flows.json'), 'utf8'))
    const parsed = FlowsDocumentSchema.parse(json)
    expect(parsed.$schema).toBe('./flows.schema.json')
    expect(parsed.flows).toEqual(doc.flows)
    const schema: unknown = JSON.parse(await readFile(join(dir, 'out', 'flows.schema.json'), 'utf8'))
    expect(schema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['formatVersion', 'flows', 'computedValues']),
    })
  })

  it('writes byte-identical files for the same document', async () => {
    await writeFlows(join(dir, 'one'), doc, { operations: capture.operations })
    await writeFlows(join(dir, 'two'), doc, {
      operations: [...capture.operations].reverse(),
    })
    for (const name of ['flows.json', 'flows.schema.json', 'flows.md'])
      expect(await readFile(join(dir, 'two', name), 'utf8')).toBe(await readFile(join(dir, 'one', name), 'utf8'))
  })

  it('refuses to write an invalid document', async () => {
    const invalid = {
      ...doc,
      flows: [
        { ...doc.flows[0]!, seenInSessions: 1.5 },
      ],
    }
    await expect(writeFlows(join(dir, 'bad'), invalid, { operations: [] })).rejects.toThrow(SiteToApiError)
    await expect(readdir(dir)).resolves.toEqual([])
  })

  it('never writes a secret value', async () => {
    await writeFlows(dir, doc, { operations: capture.operations })
    const files = await Promise.all(['flows.json', 'flows.md'].map(name => readFile(join(dir, name), 'utf8')))
    for (const content of files) {
      for (const secret of SECRET_VALUES)
        expect(content).not.toContain(secret)
    }
  })
})

describe('renderFlowsMarkdown', () => {
  const markdown = renderFlowsMarkdown(doc, capture.operations)

  it('anchors each flow by its id and lists its steps with SDK names', () => {
    expect(markdown).toContain('<a id="sign-in"></a>\n\n### Sign in')
    expect(markdown).toContain('- [Sign in](#sign-in): `postApiLogin` → `getApiItems` → `getApiNotifications`')
    expect(markdown).toContain('1. **`postApiLogin`** `POST /api/login` on `shop.example.test` (step `s1`, api)')
    expect(markdown).toContain('SDK function `postApiLogin()`, response schema `zPostApiLoginResponse`')
    expect(markdown).toContain('Sent from: `src/submitLogin.ts:42 submitLogin`')
  })

  it('renders input origins readably', () => {
    expect(markdown).toContain('- `header.authorization`: from step `s1` response `body./token` (substring)')
    expect(markdown).toContain('- `path.2`: from step `s2` of [`sign-in`](#sign-in) response `body./items/*/id`')
    expect(markdown).toContain('- `header.x-csrf-token`: from the HTML of step `s1` of [`load-login`](#load-login): `meta[name="csrf-token"]` attribute `content` (confidence high)')
    expect(markdown).toContain('- `body./username`: typed by the person into field `username`')
    expect(markdown).toContain('- `body./password`: computed by the page, see [`postapilogin-body-password`](#computed-postapilogin-body-password)')
    expect(markdown).toContain('- `cookie._abck`: set in the browser: set by page script (Akamai Bot Manager)')
    expect(markdown).toContain('- `header.x-client-version`: constant `web-4.2.1`')
  })

  it('marks browser-only steps instead of offering an SDK function', () => {
    expect(markdown).toContain('Browser only: a real browser must run this step; it is not a client function.')
    expect(markdown).not.toContain('`postAkamPixel()`')
  })

  it('says which file and function to port for a computed value', () => {
    expect(markdown).toContain('<a id="computed-postapilogin-body-password"></a>')
    expect(markdown).toContain('- Port: `src/encryptPassword.ts`, function `encryptPassword` at line 300')
    expect(markdown).toContain('- Browser API: `JSEncrypt.encrypt` (padding=pkcs1)')
    expect(markdown).toContain('  - from step `s3` of [`load-login`](#load-login) response `body./publicKey`')
  })

  it('says a step was sent after a dialog, and that plain HTTP sends it directly (decision 0064)', () => {
    const [first] = doc.flows
    const [step] = first?.steps ?? []
    if (!first || !step)
      throw new Error('the shop scenario has no flows')
    const guarded: FlowsDocument = {
      ...doc,
      flows: [
        {
          ...first,
          steps: [
            {
              ...step,
              dialogs: [
                { type: 'prompt', message: 'New name for `Weekend`' },
                { type: 'confirm', message: 'Rename the list?' },
              ],
            },
          ],
        },
      ],
    }
    const rendered = renderFlowsMarkdown(guarded, capture.operations)
    expect(rendered).toContain('   - Sent after the person accepted `prompt()` `` New name for `Weekend` ``, then `confirm()` `Rename the list?`. In a browser the dialog must be accepted; over plain HTTP send the request directly. The text typed into a prompt is sent in the request, like any other input.')
    expect(markdown).not.toContain('Sent after the person accepted')
  })

  it('summarises session requirements per host', () => {
    expect(markdown).toContain('| `shop.example.test` | browser | `_abck` (browser), `session` (`getLogin`) | Akamai | no |')
  })

  it('escapes Markdown in labels taken from the site', () => {
    const tricky: FlowsDocument = {
      ...doc,
      flows: [
        {
          ...doc.flows[0]!,
          name: 'Buy *now* | <b>',
          trigger: { ...doc.flows[0]!.trigger, label: 'Buy `now`' },
        },
      ],
    }
    const rendered = renderFlowsMarkdown(tricky, capture.operations)
    expect(rendered).toContain('### Buy \\*now\\* \\| \\<b\\>')
    expect(rendered).toContain('Trigger: load `` Buy `now` ``')
  })

  it('cannot inject links, HTML, comments, headings or table columns from site values', () => {
    const [flow] = doc.flows
    const [host] = doc.session
    const [computed] = doc.computedValues
    if (!flow || !host || !computed)
      throw new Error('scenario changed')
    const ref = {
      file: HOSTILE,
      line: 1,
      column: 1,
      functionName: HOSTILE,
      original: false,
      excerpt: HOSTILE,
    }
    const hostile: FlowsDocument = {
      ...doc,
      session: [
        {
          ...host,
          cookies: [
            { name: HOSTILE, setBy: HOSTILE, source: 'response' },
          ],
          botProtection: [
            { vendor: HOSTILE, evidence: HOSTILE },
          ],
        },
      ],
      flows: [
        {
          ...flow,
          id: HOSTILE,
          name: HOSTILE,
          trigger: { kind: 'click', label: HOSTILE, pageUrl: HOSTILE },
          steps: flow.steps.map(step => ({
            ...step,
            summary: HOSTILE,
            sentFrom: ref,
            inputs: {
              [HOSTILE]: {
                kind: 'html',
                step: `${HOSTILE}.s1`,
                selector: HOSTILE,
                attr: HOSTILE,
                pattern: HOSTILE,
                confidence: 'low',
              },
              'query.a': { kind: 'browser', note: HOSTILE },
              'query.b': { kind: 'computed', computedId: HOSTILE },
            },
            outputs: { [HOSTILE]: HOSTILE },
          })),
        },
      ],
      computedValues: [
        {
          ...computed,
          id: HOSTILE,
          input: HOSTILE,
          producedBy: ref,
          calledFrom: ref,
          api: HOSTILE,
          details: { [HOSTILE]: HOSTILE },
        },
      ],
    }
    const rendered = renderFlowsMarkdown(hostile, capture.operations)
    const html = renderMarkdown(rendered)
    expect(injected(html)).toEqual([])
    expect(html.match(/<h\d>/g)).toHaveLength(6)
    // Anchors are slugs, so a site value cannot add attributes to the <a> tag.
    expect(rendered).toMatch(/<a id="[a-z0-9_-]+"><\/a>/)
    expect(rendered).not.toMatch(/<a id="[-\d_a-z]*[^-\d"_a-z][^"]*">/)
    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []
    expect(rows).toHaveLength(2)
    for (const row of rows)
      expect(row.match(/<t[dh][\s>]/g)).toHaveLength(5)
  })

  it('names the right host for steps whose operation id exists on two hosts', () => {
    const analysis = twoHostAnalysis()
    const rendered = renderFlowsMarkdown(analysis.flows, analysis.operations)
    expect(rendered).toContain(`1. **\`getRoot\`** \`GET /\` on \`${WWW}\` (step \`s1\`, api)`)
    expect(rendered).toContain(`2. **\`getRoot\`** \`GET /\` on \`${API}\` (step \`s2\`, api)`)
    expect(rendered).toContain(`- Request value: \`header.x-sig\` of \`getRoot\` on \`${API}\``)
  })
})
