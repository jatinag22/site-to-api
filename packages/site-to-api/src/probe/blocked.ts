/**
 * Recognises a live response that bot protection sent instead of the site's answer, so `probe`
 * can say "blocked" rather than "session expired". Detection only: nothing here helps to get past
 * it (decision 0008).
 */

interface BlockSignature {
  vendor: string
  /** Matches when any header test or any body test holds (and the status test, when given). */
  status?: (status: number) => boolean
  headers?: Array<{ name: string, value?: RegExp }>
  body?: RegExp[]
}

const DENIED = (status: number): boolean => status === 403 || status === 429 || status === 503

const SIGNATURES: readonly BlockSignature[] = [
  {
    vendor: 'Cloudflare',
    headers: [
      { name: 'cf-mitigated', value: /challenge/i },
    ],
  },
  {
    vendor: 'Cloudflare',
    status: DENIED,
    body: [/\/cdn-cgi\/challenge-platform\//, /<title>Just a moment\.\.\.<\/title>/i, /Attention Required! \| Cloudflare/i],
  },
  {
    vendor: 'DataDome',
    headers: [
      { name: 'x-datadome' },
    ],
    body: [/captcha-delivery\.com/],
  },
  {
    vendor: 'PerimeterX',
    body: [/px-captcha/, /perimeterx\.net/],
  },
  {
    vendor: 'Imperva',
    body: [/_Incapsula_Resource/, /Request unsuccessful\. Incapsula/i],
  },
  {
    vendor: 'Kasada',
    status: DENIED,
    headers: [
      { name: 'x-kpsdk-ct' },
    ],
  },
  {
    vendor: 'Akamai',
    status: DENIED,
    headers: [
      { name: 'server', value: /AkamaiGHost/i },
    ],
  },
  {
    vendor: 'Amazon robot check',
    body: [/\/errors\/validateCaptcha/, /api-services-support@amazon\.com/],
  },
]

/** The vendor and the evidence when a response is a bot-protection block or challenge, else null. */
export function detectBlock(status: number, headers: Headers, body: string): string | null {
  for (const signature of SIGNATURES) {
    if (signature.status && !signature.status(status))
      continue
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
