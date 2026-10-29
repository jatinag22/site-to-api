/**
 * Helpers the generated GraphQL functions use (site-to-api decision 0027). A GraphQL operation's
 * spec path is `<endpoint>#<operationName>` when several operations share an endpoint; hey-api
 * then builds `<endpoint>#<name>?<query>`, which would hide the query string in the fragment.
 */

/**
 * `https://h/graphql#getUser?x=1` → `https://h/graphql?x=1`. A fragment is never sent, so
 * dropping it changes nothing else; a query string after it belongs to the request.
 */
export function withoutFragment(url: string): string {
  const hash = url.indexOf('#')
  if (hash === -1)
    return url
  const base = url.slice(0, hash)
  const fragment = url.slice(hash + 1)
  const query = fragment.indexOf('?')
  if (query === -1)
    return base
  const search = fragment.slice(query + 1)
  if (search === '')
    return base
  return `${base}${base.includes('?')
    ? '&'
    : '?'}${search}`
}

/**
 * Wraps `fetch` so every request goes to its URL without the fragment (see
 * {@link withoutFragment}). Without an argument it calls `globalThis.fetch` at request time.
 */
export function fetchWithoutFragment(fetchImpl?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const send = fetchImpl ?? globalThis.fetch
    const request = new Request(input, init)
    const url = withoutFragment(request.url)
    if (url === request.url)
      return send(request)
    return send(new Request(url, {
      method: request.method,
      headers: request.headers,
      body: request.body === null
        ? null
        : await request.arrayBuffer(),
      redirect: request.redirect,
      // `credentials` and `referrerPolicy` are left out on purpose: Cloudflare Workers rejects them.
      signal: request.signal,
    }))
  }
}

function encode(value: unknown, json: boolean): string | null {
  if (value === undefined)
    return null
  if (json)
    return JSON.stringify(value)
  if (typeof value === 'string')
    return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  return JSON.stringify(value)
}

/**
 * A hey-api `querySerializer` for GraphQL over GET: the names in `jsonNames` (`variables`,
 * `extensions`) are sent as JSON text, every other value as itself; arrays repeat the name.
 * Keys keep their order, so the URL is the one the site's own code builds.
 */
export function graphqlQuerySerializer(jsonNames: readonly string[]): (query: Record<string, unknown>) => string {
  const json = new Set(jsonNames)
  return (query) => {
    const params = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) {
      const values: unknown[] = Array.isArray(value) && !json.has(name)
        ? value
        : [value]
      for (const item of values) {
        const text = encode(item, json.has(name))
        if (text !== null)
          params.append(name, text)
      }
    }
    return params.toString()
  }
}
