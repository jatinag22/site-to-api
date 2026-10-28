/**
 * The cookie lines of a host, shared by `AGENT.md` and `client/README.md` so both say the same
 * thing about which cookies the API needs. Before `probe`, a cookie is only known to have been
 * seen in the capture; after `probe` minimized requests on the host, each cookie says whether any
 * of them needed it.
 */
import type { SessionRequirement } from '../model'
import { code } from './escape'

type Cookie = SessionRequirement['cookies'][number]

function cookieOrigin(cookie: Cookie): string {
  switch (cookie.source) {
    case 'browser':
      return 'set by a script in the page; only a real browser produces its value'
    case 'script':
      return 'set by a script in the page; the wrapper can set its value itself'
    case 'response':
      return cookie.setBy
        ? `set by ${code(cookie.setBy)}`
        : 'set by a response'
    case 'unknown':
      return 'present in the browser profile; origin unknown (no captured response or page script set it, so check with `probe` whether the API needs it)'
  }
}

function requests(count: number): string {
  return `${count} request${count === 1
    ? ''
    : 's'}`
}

/**
 * One Markdown list item per cookie of `entry`, sorted by name. `tested` holds the
 * `requires` list (`cookie:<name>`, `header:<name>`, ...) of every operation on this host that
 * `probe` minimized; it is empty before probing. Cookies probe found necessary but no captured
 * step set get a line of their own.
 */
export function cookieLines(entry: SessionRequirement, tested: ReadonlyArray<readonly string[]>): string[] {
  const needed = new Map<string, number>()
  for (const requires of tested) {
    for (const item of requires) {
      if (item.startsWith('cookie:')) {
        const name = item.slice('cookie:'.length)
        needed.set(name, (needed.get(name) ?? 0) + 1)
      }
    }
  }
  const known = new Set(entry.cookies.map(cookie => cookie.name))
  const lines = [...entry.cookies].sort((a, b) => a.name.localeCompare(b.name)).map((cookie) => {
    const origin = cookieOrigin(cookie)
    if (tested.length === 0)
      return `- Cookie ${code(cookie.name)}: ${origin} (seen in capture).`
    const count = needed.get(cookie.name) ?? 0
    return count > 0
      ? `- Cookie ${code(cookie.name)}: ${origin}. Needed by ${requests(count)} (confirmed by probe).`
      : `- Cookie ${code(cookie.name)}: ${origin}. Seen in capture, but none of the ${requests(tested.length)} probe tested needed it.`
  })
  for (const [name, count] of [...needed].filter(([name]) => !known.has(name)).sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`- Cookie ${code(name)}: needed by ${requests(count)} (confirmed by probe); no captured step was found to set it.`)
  return lines
}
