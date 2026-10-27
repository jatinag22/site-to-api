import type { FlowsDocument } from '../../model'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeHtmlLocator, fakeSourceResolver, SECRET_VALUES, shopCapture } from '../../../test/scenarios'
import { traceValues } from '../../analyze/correlate'
import { buildFlows } from '../../analyze/flows'
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
    expect(markdown).toContain('- `path.2`: from step `s2` of [`sign-in`](#sign-in) response `body./items/0/id`')
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
})
