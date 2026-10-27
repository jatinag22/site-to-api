/**
 * A toy stand-in for a bot-protection product, named and shaped like Akamai Bot Manager
 * (`_abck` and `bm_sz` cookies, a sensor script posting `sensor_data`) so the tool's
 * bot-protection detection has something to find. It is not a vendor script and contains no
 * anti-bot logic: any non-empty `sensor_data` earns a cookie. The only check is that `/api/*`
 * calls carry a cookie this server signed.
 */
import { createHmac } from 'node:crypto'
import { createRng } from './random'

export interface Shield {
  /** A new `_abck` value, issued in answer to `POST /shield/collect`. */
  issueAbck: () => string
  isValidAbck: (value: string | undefined) => boolean
  /** A new `bm_sz` value, set on HTML pages like the real product does. */
  issueBmSz: () => string
}

/** Creates the shield. Values are derived from `seed`, so runs are reproducible. */
export function createShield(seed: number): Shield {
  const rng = createRng(seed ^ 0xABC)
  const secret = rng.hex(16)

  function signature(id: string): string {
    return createHmac('sha256', secret).update(id).digest('hex').slice(0, 24)
  }

  return {
    issueAbck: () => {
      const id = rng.hex(16).toUpperCase()
      return `${id}~0~${signature(id)}~-1`
    },
    isValidAbck: (value) => {
      const [id, , sig] = (value ?? '').split('~')
      return id !== undefined && id !== '' && sig === signature(id)
    },
    issueBmSz: () => `${rng.hex(16).toUpperCase()}~YAAQ${rng.hex(12)}`,
  }
}
