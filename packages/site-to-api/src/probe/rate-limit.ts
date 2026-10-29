/**
 * Spaces requests to the live site evenly (decision 0012). Shared by `probe` and the MCP
 * servers' calls, so a tool cannot send faster than probe would.
 */
export class RateLimiter {
  private next = 0

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async wait(): Promise<void> {
    const current = this.now()
    const start = Math.max(current, this.next)
    this.next = start + this.intervalMs
    if (start > current)
      await this.sleep(start - current)
  }
}
