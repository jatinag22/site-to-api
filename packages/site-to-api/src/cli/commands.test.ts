import type { CaptureResult } from '../capture'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { consola } from 'consola'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCapture } from '../capture'
import { pipelineCommands } from './commands'
import { createProgram, run } from './program'
import { stampSkill } from './skill'

vi.mock('../capture', async importOriginal => ({
  ...await importOriginal<typeof import('../capture')>(),
  runCapture: vi.fn(),
}))

let dir: string

beforeEach(async () => {
  vi.mocked(runCapture).mockClear()
  dir = await mkdtemp(join(tmpdir(), 'site-to-api-capture-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** Writes `count` session folders and makes the mocked capture report the last one. */
async function sessions(count: number): Promise<void> {
  const rawDir = join(dir, 'captures')
  for (let index = 0; index < count; index++) {
    await mkdir(join(rawDir, `s${index}`), { recursive: true })
    await writeFile(join(rawDir, `s${index}`, 'meta.json'), '{}')
  }
  const sessionId = `s${count - 1}`
  const result: CaptureResult = {
    sessionDir: join(rawDir, sessionId),
    warnings: [],
    requests: 1,
    events: 0,
    meta: {
      formatVersion: 1,
      sessionId,
      toolVersion: 'test',
      startUrl: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      browser: { channel: null, headless: true, userAgent: 'test' },
      har: 'traffic.har',
      events: 'events.jsonl',
      scripts: [],
    },
  }
  vi.mocked(runCapture).mockResolvedValue(result)
}

async function nextStep(): Promise<string | undefined> {
  const info = vi.spyOn(consola, 'info').mockImplementation(() => {})
  vi.spyOn(consola, 'success').mockImplementation(() => {})
  await run([
    'node',
    'site-to-api',
    '--cwd',
    dir,
    '--raw-dir',
    'captures',
    'capture',
    '--headless',
    '--script',
    'drive.mjs',
  ], pipelineCommands)
  return info.mock.calls.map(call => String(call[0])).find(message => message.startsWith('Next:'))
}

describe('capture', () => {
  it('suggests a second sample after the first session', async () => {
    await sessions(1)
    expect(await nextStep()).toBe('Next: `site-to-api build` (capture again for a second sample of the same pages first, if you can)')
  })

  it('only suggests build once two sessions exist', async () => {
    await sessions(2)
    expect(await nextStep()).toBe('Next: `site-to-api build`')
  })
})

describe('stale skill copy', () => {
  /** The info lines a capture prints with stdout a terminal or not. */
  async function captureInfo(tty: boolean): Promise<string[]> {
    const info = vi.spyOn(consola, 'info').mockImplementation(() => {})
    vi.spyOn(consola, 'success').mockImplementation(() => {})
    const previous = process.stdout.isTTY
    process.stdout.isTTY = tty
    try {
      await run([
        'node',
        'site-to-api',
        '--cwd',
        dir,
        '--raw-dir',
        'captures',
        'capture',
        '--minimized',
        '--script',
        'drive.mjs',
      ], pipelineCommands)
    }
    finally {
      process.stdout.isTTY = previous
    }
    return info.mock.calls.map(call => String(call[0]))
  }

  beforeEach(async () => {
    await sessions(1)
    await mkdir(join(dir, '.claude', 'skills', 'site-to-api'), { recursive: true })
    await writeFile(join(dir, '.claude', 'skills', 'site-to-api', 'SKILL.md'), stampSkill('---\nname: site-to-api\n---\n', '0.0.1'))
  })

  it('tells an agent that the project\'s copy is from an older version', async () => {
    expect(await captureInfo(false)).toContainEqual(expect.stringMatching(/^Agents: this project's copy of the site-to-api skill \(.*\.claude\/skills\/site-to-api\/SKILL\.md\) is from site-to-api 0\.0\.1; this is .*\. Run `site-to-api init --agent` to update it\.$/))
  })

  it('keeps a person\'s terminal free of it', async () => {
    expect((await captureInfo(true)).some(line => line.includes('is from site-to-api'))).toBe(false)
  })
})

describe('capture output', () => {
  it('says once where the session was saved, with pluralised counts', async () => {
    await sessions(1)
    const info = vi.spyOn(consola, 'info').mockImplementation(() => {})
    const success = vi.spyOn(consola, 'success').mockImplementation(() => {})
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      '--raw-dir',
      'captures',
      'capture',
      '--minimized',
      '--script',
      'drive.mjs',
    ], pipelineCommands)
    expect(success.mock.calls.map(call => String(call[0]))).toEqual([
      `Saved session s0 to ${join(dir, 'captures', 's0')} (1 request, 0 events, 0 scripts).`,
    ])
    expect(info.mock.calls.some(call => String(call[0]).includes('Saved'))).toBe(false)
  })

  it('shows the browser instructions only when a person is at the terminal', async () => {
    await sessions(1)
    vi.spyOn(consola, 'info').mockImplementation(() => {})
    vi.spyOn(consola, 'success').mockImplementation(() => {})
    const tty = process.stdin.isTTY
    try {
      process.stdin.isTTY = false
      await run([
        'node',
        'site-to-api',
        '--cwd',
        dir,
        '--raw-dir',
        'captures',
        'capture',
        '--minimized',
      ], pipelineCommands)
      process.stdin.isTTY = true
      await run([
        'node',
        'site-to-api',
        '--cwd',
        dir,
        '--raw-dir',
        'captures',
        'capture',
        '--minimized',
      ], pipelineCommands)
    }
    finally {
      process.stdin.isTTY = tty
    }
    expect(vi.mocked(runCapture).mock.calls.map(call => call[1].instructions)).toEqual([false, true])
  })
})

describe('capture arguments', () => {
  async function capture(...args: string[]): Promise<string[]> {
    const errors: string[] = []
    vi.spyOn(consola, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message))
    })
    await run([
      'node',
      'site-to-api',
      '--cwd',
      dir,
      'capture',
      ...args,
    ], pipelineCommands)
    process.exitCode = undefined
    return errors
  }

  it('refuses --headless without --script, before any browser starts', async () => {
    expect(await capture('https://shop.test', '--headless')).toEqual([
      expect.stringMatching(/^--headless needs a capture script: .*Add --script <file>/),
    ])
    expect(runCapture).not.toHaveBeenCalled()
  })

  it('refuses a junk URL with an example and adds a scheme to a bare host', async () => {
    expect(await capture('not a url')).toEqual([
      expect.stringContaining('"not a url" is not a URL. Pass the page to open first, for example https://example.com'),
    ])
    expect(runCapture).not.toHaveBeenCalled()
    await sessions(1)
    vi.spyOn(consola, 'info').mockImplementation(() => {})
    vi.spyOn(consola, 'success').mockImplementation(() => {})
    expect(await capture('localhost:4173/shop', '--minimized', '--script', 'drive.mjs')).toEqual([])
    expect(vi.mocked(runCapture).mock.calls[0]?.[1].url).toBe('http://localhost:4173/shop')
  })

  it('refuses an unknown --channel and lists the channels capture can use', async () => {
    const stderr: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    })
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exited')
    })
    await expect(capture('https://shop.test', '--channel', 'firefox')).rejects.toThrow('exited')
    expect(stderr.join('')).toContain('"firefox" is not a browser capture can use. Capture records with Chromium-based browsers: chrome, chrome-beta')
    expect(stderr.join('')).not.toContain('install firefox')
    expect(runCapture).not.toHaveBeenCalled()
  })

  it('falls back from Chrome only when the channel was not chosen', async () => {
    await sessions(1)
    vi.spyOn(consola, 'info').mockImplementation(() => {})
    vi.spyOn(consola, 'success').mockImplementation(() => {})
    await capture('https://shop.test', '--minimized', '--script', 'drive.mjs')
    await capture('https://shop.test', '--minimized', '--script', 'drive.mjs', '--channel', 'chrome')
    expect(vi.mocked(runCapture).mock.calls.map(call => call[1].channelFallback)).toEqual([true, false])
  })
})

describe('help', () => {
  it('lists the global options in every command\'s help, and explains each --examples value', () => {
    const program = createProgram(pipelineCommands)
    for (const command of program.commands) {
      const help = command.helpInformation()
      expect(help, command.name()).toContain('Global Options:')
      expect(help, command.name()).toMatch(/--cwd <dir>[\s\S]*--raw-dir <dir>[\s\S]*--out-dir <dir>/)
    }
    const build = program.commands.find(command => command.name() === 'build')?.helpInformation() ?? ''
    expect(build).toMatch(/masked: secrets and personal data replaced \(default\)\n\s+raw: captured values as they are, personal data too\n\s+none: no example values/)
  })
})
