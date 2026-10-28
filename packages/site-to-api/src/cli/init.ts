import { existsSync } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'pathe'

const CONFIG_TEMPLATE = `import { defineConfig } from 'site-to-api'

export default defineConfig({
  // Raw captures hold real cookies, tokens and personal data. Keep this folder out of git.
  rawDir: '.site-to-api/raw',
  // The handoff folder for your coding agent. Redacted by default; review it before publishing.
  outDir: 'api-handoff',
  hosts: {
    // Leave empty to analyse every host the site's pages talk to (minus analytics and ads).
    include: [],
    exclude: [],
  },
  capture: {
    browser: { channel: 'chrome', headless: false },
  },
  redact: {
    // 'masked' keeps formats but hides secrets and personal data. 'raw' copies real values.
    examples: 'masked',
  },
  probe: {
    // Be polite to the site: requests per second when replaying.
    maxRps: 1,
    // Operations per host whose required cookies and headers are worked out one by one.
    minimizePerHost: 5,
  },
})
`

const GITIGNORE_ENTRY = `
# site-to-api raw captures: real cookies, tokens and personal data
.site-to-api/
`

export interface InitResult {
  created: string[]
  skipped: string[]
}

/** Writes a starter config and makes sure raw captures are gitignored. Never overwrites. */
export async function initProject(cwd: string): Promise<InitResult> {
  const created: string[] = []
  const skipped: string[] = []

  const configPath = join(cwd, 'site-to-api.config.ts')
  if (existsSync(configPath)) {
    skipped.push(configPath)
  }
  else {
    await writeFile(configPath, CONFIG_TEMPLATE)
    created.push(configPath)
  }

  const gitignorePath = join(cwd, '.gitignore')
  const current = existsSync(gitignorePath)
    ? await readFile(gitignorePath, 'utf8')
    : ''
  if (current.split('\n').some(line => line.trim() === '.site-to-api/')) {
    skipped.push(gitignorePath)
  }
  else {
    await appendFile(gitignorePath, GITIGNORE_ENTRY)
    created.push(gitignorePath)
  }

  return { created, skipped }
}
