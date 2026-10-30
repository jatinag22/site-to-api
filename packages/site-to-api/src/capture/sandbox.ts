/**
 * Chromium's sandbox for captures (decision 0047). Captured sites are untrusted input (0019), and
 * Playwright launches Chromium with `--no-sandbox` unless `chromiumSandbox` is set, so the sandbox
 * is asked for explicitly. Where it cannot start (Linux containers and CI runners without
 * unprivileged user namespaces) a capture without it still beats no capture, said out loud.
 */
import process from 'node:process'

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? text
}

/**
 * Chromium's own wording when its sandbox cannot start: "No usable sandbox!", user namespaces
 * that cannot be created, a setuid sandbox helper that is missing or not set up, and the zygote
 * dying because of either.
 */
const SANDBOX_FAILURE = /no usable sandbox|namespace|setuid sandbox|zygote/i

/** True when a launch error is Chromium failing to start its sandbox on Linux. */
export function isSandboxFailure(error: unknown, platform: string): boolean {
  return platform === 'linux' && SANDBOX_FAILURE.test(message(error))
}

/**
 * Runs `launch(true)` when `sandbox` is on. Only when that fails because the sandbox cannot start
 * (on Linux, see {@link isSandboxFailure}) is `launch(false)` run once, with a warning through
 * `warn`; any other error, and a failed retry, throws the first error. With `sandbox` off, only
 * `launch(false)` runs.
 */
export async function launchWithSandbox<T>(launch: (sandbox: boolean) => Promise<T>, sandbox: boolean, warn: (message: string) => void, platform: string = process.platform): Promise<T> {
  if (!sandbox)
    return await launch(false)
  try {
    return await launch(true)
  }
  catch (sandboxed) {
    if (!isSandboxFailure(sandboxed, platform))
      throw sandboxed
    let result: T
    try {
      result = await launch(false)
    }
    catch {
      throw sandboxed
    }
    warn(`The browser could not start with its sandbox (${firstLine(message(sandboxed))}), so this capture runs without it and a malicious page meets fewer barriers. Allow unprivileged user namespaces or capture outside the container; set capture.browser.sandbox to false to skip the sandboxed attempt.`)
    return result
  }
}
