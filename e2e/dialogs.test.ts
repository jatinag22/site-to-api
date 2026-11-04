/**
 * JavaScript dialogs in scripted captures (decision 0059), against the saved-lists fixture page:
 * a script that accepts the `confirm()` before a delete gets the `DELETE` captured and documented;
 * a script that does not handle dialogs gets Playwright's dismissal and a warning; a dialog a
 * script leaves open does not hold up saving. Every dialog is in `events.jsonl` with its answer,
 * and `build` marks the flow step each accepted dialog guarded (decision 0064).
 */
import type { ResolvedConfig } from '../packages/site-to-api/src'
import type { CaptureEvent, DialogEvent } from '../packages/site-to-api/src/model'
import type { DialogSite } from './fixture-site/dialogs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../packages/site-to-api/src'
import { buildHandoff } from '../packages/site-to-api/src/build'
import { runCapture } from '../packages/site-to-api/src/capture'
import { CaptureEventSchema } from '../packages/site-to-api/src/model'
import { startDialogSite } from './fixture-site/dialogs'

const here = fileURLToPath(new URL('.', import.meta.url))
const work = join(here, '.output', 'dialogs')

/** Accepts every dialog, typing a new list name into the prompt. */
const ACCEPTS = `
export default async ({ page, baseUrl }) => {
  page.on('dialog', dialog => dialog.type() === 'prompt' ? dialog.accept('Weekly shop') : dialog.accept())
  await page.goto(baseUrl)
  await page.getByRole('button', { name: 'Rename' }).click()
  await page.getByText('Renamed').waitFor()
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByText('Deleted').waitFor()
}
`

/** Handles no dialogs, as most Playwright scripts do. */
const IGNORES = `
export default async ({ page, baseUrl }) => {
  await page.goto(baseUrl)
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByText('Kept').waitFor()
}
`

/** Listens for dialogs but never answers one, then returns with the confirm still open. */
const LEAVES_OPEN = `
export default async ({ page, baseUrl }) => {
  page.on('dialog', () => {})
  await page.goto(baseUrl)
  const shown = page.waitForEvent('dialog')
  // A click does not finish while the dialog it opened is up, so it is not awaited.
  page.getByRole('button', { name: 'Delete' }).click().catch(() => {})
  await shown
}
`

let site: DialogSite

function configFor(name: string): ResolvedConfig {
  return ConfigSchema.parse({
    rawDir: join(work, name, 'raw'),
    outDir: join(work, name, 'handoff'),
    capture: {
      // GitHub's Ubuntu runners cannot start Chromium's sandbox; locally it is on (decision 0047).
      browser: { channel: null, headless: true, sandbox: process.env.CI !== 'true' },
      script: `${name}.mjs`,
    },
  })
}

async function readEvents(sessionDir: string): Promise<CaptureEvent[]> {
  const text = await readFile(join(sessionDir, 'events.jsonl'), 'utf8')
  return text.trim().split('\n').map(line => CaptureEventSchema.parse(JSON.parse(line)))
}

function dialogsOf(events: CaptureEvent[]): DialogEvent[] {
  return events.filter((event): event is DialogEvent => event.t === 'dialog')
}

beforeAll(async () => {
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  await writeFile(join(work, 'accepts.mjs'), ACCEPTS)
  await writeFile(join(work, 'ignores.mjs'), IGNORES)
  await writeFile(join(work, 'leaves-open.mjs'), LEAVES_OPEN)
  site = await startDialogSite()
})

afterAll(async () => {
  await site?.close()
})

describe('a capture script that accepts the dialogs', () => {
  it('captures the DELETE behind the confirm, records each dialog, and documents the operation', async () => {
    const config = configFor('accepts')
    site.apiCalls.length = 0
    const result = await runCapture(config, { url: `${site.origin}/lists`, sessionId: 'accepts', cwd: work })
    expect(result.meta.incomplete).toBeUndefined()
    expect(site.apiCalls).toEqual(['POST /api/lists/42', 'DELETE /api/lists/42'])
    expect(result.warnings.join('\n')).not.toMatch(/Dismissed/)

    const har: unknown = JSON.parse(await readFile(join(result.sessionDir, 'traffic.har'), 'utf8'))
    expect(har).toMatchObject({
      log: {
        entries: expect.arrayContaining([
          expect.objectContaining({
            request: expect.objectContaining({ method: 'DELETE', url: `${site.origin}/api/lists/42` }),
          }),
        ]),
      },
    })

    const dialogs = dialogsOf(await readEvents(result.sessionDir))
    expect(dialogs.map(({ type, message, answer, pageUrl }) => ({ type, message, answer, pageUrl }))).toEqual([
      {
        type: 'prompt',
        message: 'New name for "Weekend"',
        answer: 'accepted',
        pageUrl: `${site.origin}/lists`,
      },
      {
        type: 'confirm',
        message: 'Delete the list "Weekend"? This cannot be undone.',
        answer: 'accepted',
        pageUrl: `${site.origin}/lists`,
      },
    ])
    for (const dialog of dialogs)
      expect(dialog.answeredTs).toBeGreaterThanOrEqual(dialog.ts)
    // The prompt's answer is in the request it sent, but never in the dialog event.
    expect(JSON.stringify(dialogs)).not.toContain('Weekly shop')

    const { analysis } = await buildHandoff({ config, cwd: work })
    const operations = analysis.operations.filter(operation => operation.kind === 'api').map(operation => `${operation.method} ${operation.path}`)
    expect(operations).toEqual(expect.arrayContaining([
      expect.stringMatching(/^DELETE \/api\/lists\//),
      expect.stringMatching(/^POST \/api\/lists\//),
    ]))

    // Decision 0064: the step behind each dialog says so, and nothing else does.
    const methodOf = new Map(analysis.operations.map(operation => [operation.operationId, operation.method]))
    const steps = analysis.flows.flows.flatMap(flow => flow.steps.map(step => ({
      flow: flow.trigger.label,
      method: methodOf.get(step.operationId),
      dialogs: step.dialogs,
    })))
    expect(steps.filter(step => step.dialogs !== undefined)).toEqual([
      {
        flow: 'Rename',
        method: 'POST',
        dialogs: [
          { type: 'prompt', message: 'New name for "Weekend"' },
        ],
      },
      {
        flow: 'Delete',
        method: 'DELETE',
        dialogs: [
          { type: 'confirm', message: 'Delete the list "Weekend"? This cannot be undone.' },
        ],
      },
    ])
    const flowsJson = await readFile(join(work, 'accepts', 'handoff', 'flows.json'), 'utf8')
    expect(JSON.parse(flowsJson)).toMatchObject({ formatVersion: 2 })
    const flowsMd = await readFile(join(work, 'accepts', 'handoff', 'flows.md'), 'utf8')
    expect(flowsMd).toContain('Sent after the person accepted `confirm()` `Delete the list "Weekend"? This cannot be undone.`.')
    expect(flowsMd).toContain('Sent after the person accepted `prompt()` `New name for "Weekend"`.')
    // The prompt's answer is never written as a dialog's text or a step's input origin.
    expect(flowsJson).not.toContain('Weekly shop')
    expect(flowsMd).not.toContain('Weekly shop')
    const guide = await readFile(join(work, 'accepts', 'handoff', 'AGENT.md'), 'utf8')
    expect(guide).toMatch(/\(after confirm\(\)\)/)
  })
})

describe('a capture script that handles no dialogs', () => {
  it('gets Playwright\'s dismissal: no DELETE, the dismissed confirm recorded and a warning', async () => {
    site.apiCalls.length = 0
    const result = await runCapture(configFor('ignores'), { url: `${site.origin}/lists`, sessionId: 'ignores', cwd: work })
    expect(result.meta.incomplete).toBeUndefined()
    expect(site.apiCalls).toEqual([])
    const dialogs = dialogsOf(await readEvents(result.sessionDir))
    expect(dialogs.map(({ type, answer }) => `${type}:${answer}`)).toEqual(['confirm:dismissed'])
    const warning = result.warnings.find(text => text.startsWith('Dismissed'))
    expect(warning).toContain('1 confirm')
    // The warning names the dialog type only; its text could hold personal data.
    expect(warning).not.toContain('Weekend')
  })
})

describe('a capture script that leaves a dialog open', () => {
  it('still saves a complete session promptly and records the dialog as unanswered', async () => {
    site.apiCalls.length = 0
    const started = Date.now()
    const result = await runCapture(configFor('leaves-open'), { url: `${site.origin}/lists`, sessionId: 'leaves-open', cwd: work })
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(result.meta.incomplete).toBeUndefined()
    expect(site.apiCalls).toEqual([])
    expect(result.warnings.find(text => text.startsWith('Dismissed'))).toContain('1 confirm')
    const dialogs = dialogsOf(await readEvents(result.sessionDir))
    expect(dialogs.map(({ type, answer, answeredTs }) => ({ type, answer, answeredTs }))).toEqual([
      { type: 'confirm', answer: 'unanswered', answeredTs: null },
    ])
  })
})
