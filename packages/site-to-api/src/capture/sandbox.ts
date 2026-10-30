/**
 * Chromium's sandbox for captures (decision 0047). Captured sites are untrusted input (0019), and
 * Playwright launches Chromium with `--no-sandbox` unless `chromiumSandbox` is set, so the sandbox
 * is asked for explicitly. Where it cannot start (Linux containers and CI runners without
 * unprivileged user namespaces) a capture without it still beats no capture, said out loud.
 */
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? text
}

/**
 * Runs `launch(true)` when `sandbox` is on; if that throws, runs `launch(false)` once and reports
 * the fallback through `warn`. When the retry fails as well, the first error is thrown: it says
 * why the browser did not start. With `sandbox` off, only `launch(false)` runs.
 */
export async function launchWithSandbox<T>(launch: (sandbox: boolean) => Promise<T>, sandbox: boolean, warn: (message: string) => void): Promise<T> {
  if (!sandbox)
    return await launch(false)
  try {
    return await launch(true)
  }
  catch (sandboxed) {
    let result: T
    try {
      result = await launch(false)
    }
    catch {
      throw sandboxed
    }
    warn(`The browser could not start with its sandbox (${firstLine(message(sandboxed))}), so this capture runs without it and a malicious page meets fewer barriers. On Linux, allow unprivileged user namespaces or capture outside the container; set capture.browser.sandbox to false to skip the sandboxed attempt.`)
    return result
  }
}
