/**
 * Recognises a live response that bot protection sent instead of the site's answer, so `probe`
 * can say "blocked" rather than "session expired". Detection only: nothing here helps to get past
 * it (decision 0008).
 */

interface BlockSignature {
  vendor: string
  /** A challenge-specific header, or markers that only a challenge or block page contains. */
  headers?: Array<{ name: string, value?: RegExp }>
  body?: RegExp[]
}

/**
 * Only a denial counts: vendors add their headers and script includes to ordinary responses too
 * (`x-datadome: protected`, PerimeterX and Incapsula scripts on every page), so a signature is
 * read only on a 403, 429 or 503, and only with a marker of the challenge itself.
 */
const DENIED = new Set([403, 429, 503])

const SIGNATURES: readonly BlockSignature[] = [
  {
    vendor: 'Cloudflare',
    headers: [
      { name: 'cf-mitigated', value: /challenge/i },
    ],
  },
  {
    vendor: 'Cloudflare',
    body: [/<title>Just a moment\.\.\.<\/title>/i, /Attention Required! \| Cloudflare/i, /cf-chl-/],
  },
  {
    vendor: 'DataDome',
    body: [/captcha-delivery\.com/],
  },
  {
    vendor: 'PerimeterX',
    // Its HTML page, or the JSON block an API gets: `{ "appId": "PX…", "blockScript": "…" }`.
    body: [/px-captcha/, /"appId"\s*:\s*"PX[^"]*"[\s\S]*"blockScript"|"blockScript"[\s\S]*"appId"\s*:\s*"PX/],
  },
  {
    vendor: 'Imperva',
    body: [/Request unsuccessful\. Incapsula incident/i],
  },
  {
    vendor: 'Kasada',
    headers: [
      { name: 'x-kpsdk-ct' },
    ],
  },
  {
    vendor: 'Akamai',
    body: [/<TITLE>Access Denied<\/TITLE>[\s\S]*errors\.edgesuite\.net/i],
  },
  {
    vendor: 'Amazon robot check',
    body: [/\/errors\/validateCaptcha/],
  },
]

/** The vendor and the evidence when a response is a bot-protection block or challenge, else null. */
export function detectBlock(status: number, headers: Headers, body: string): string | null {
  if (!DENIED.has(status))
    return null
  for (const signature of SIGNATURES) {
    const header = signature.headers?.find((test) => {
      const value = headers.get(test.name)
      return value !== null && (test.value === undefined || test.value.test(value))
    })
    if (header)
      return `${signature.vendor}: header ${header.name}, status ${status}`
    const pattern = signature.body?.find(test => test.test(body))
    if (pattern)
      return `${signature.vendor}: challenge page, status ${status}`
  }
  return null
}
