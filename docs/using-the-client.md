# Using the generated client

How to set up a project around the client that `build` and `gen` generate, with a complete
wrapper for the fixture shop. The generated `client/README.md` is the reference for one site: what
each host's session needs, which operations are secured, the HTML parsers and the channels. The
runtime it imports is documented in [packages/runtime/README.md](../packages/runtime/README.md).

## Project setup

The client is TypeScript that imports `site-to-api-runtime` and `zod` (4.1 or later). In the
folder you ran `init` in:

```sh
npm init -y && npm pkg set type=module        # ES modules
npm install site-to-api-runtime zod
npm install playwright tsx                     # playwright only for browserSession; tsx to run .ts
npm install -D site-to-api typescript @types/node
```

A `tsconfig.json` that type-checks the whole folder, the client included:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noEmit": true
  }
}
```

`"module": "esnext"` with `"moduleResolution": "bundler"` works too, and the client also compiles
under `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Run files with `tsx`, or drop
`noEmit`, compile with `tsc` and run with `node`. The code excerpts in `source/` are Markdown files
(`crypto.L18-28.ts.md`): fragments of the site's code for reading, which the compiler never sees.

## Where the client lives

By default the client is `api-handoff/client/`. Set `gen.clientDir` to put it in your app's source
tree instead:

```ts
// site-to-api.config.ts
import { defineConfig } from 'site-to-api'

export default defineConfig({
  gen: { clientDir: 'src/site-client' },
})
```

- `build.json` records the folder, so `gen`, `mcp` and `call_operation` find it from the handoff
  folder alone. When it changes, the old folder is left in place with a warning; delete it once
  nothing imports it.
- An MCP server (`--mcp`) goes to `mcp/` next to the client folder (`src/mcp/` here), or to
  `gen.mcpDir`. Your app never imports it. A type check that includes it needs
  `@modelcontextprotocol/server` installed; otherwise add its folder to `exclude` in
  `tsconfig.json`.
- `gen` replaces only the files it generated, recorded with their hashes in `build.json`. Your own
  files in the client folder stay, and a generated file you edited is kept and named in a warning
  until `--force` overwrites it.
- Commit the client folder and the handoff folder: both are redacted, and `gen` can regenerate the
  client from the handoff folder alone. Never commit `.site-to-api/` (raw captures), a saved
  cookie jar or credentials.

## Example: log in and list orders on the fixture shop

This is the complete wrapper an agent would write from the handoff folder of the
[fixture walkthrough](../README.md#try-it-on-the-fixture-shop-first). The shop needs a browser
session (bot protection), a CSRF token from the login page, a password encrypted in the browser and
a bearer token. With the setup above and the default client folder, it type-checks under `strict`
and prints `200 3 orders` (with `gen.clientDir: 'src/site-client'`, import
`./src/site-client/index.js` instead):

```ts
import { chromium } from 'playwright'
import { browserSession, CookieJar, createSiteClient, extractCsrfTokenFromGetLogin } from './api-handoff/client/index.js'

// Ported from the site's own code: api-handoff/source/src/auth/crypto.L18-28.ts.md
async function encryptPassword(password: string, publicKeySpki: string): Promise<string> {
  const spki = Uint8Array.from(atob(publicKeySpki), char => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(password))
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
}

const jar = new CookieJar()
// The shop sits behind bot protection: a real browser loads it once, its cookies are reused.
const session = browserSession({
  jar,
  bootstrap: async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
      return await page.context().cookies()
    }
    finally {
      await browser.close()
    }
  },
})

let token: string | undefined
const { sdk } = createSiteClient({
  host: 'localhost:4173',
  session,
  jar,
  auth: () => token && `Bearer ${token}`, // sent to operations the spec marks as secured
})

const loginPage = await sdk.getLogin({})
const csrf = extractCsrfTokenFromGetLogin(String(loginPage.data))
const { data: key } = await sdk.getApiAuthKey({})
if (!key?.publicKey)
  throw new Error('the login key endpoint returned no public key')
const login = await sdk.postApiAuthLogin({
  headers: { 'x-csrf-token': csrf ?? '' },
  body: { username: 'demo', password: await encryptPassword('demo-password', key.publicKey) },
})
token = login.data?.token

const orders = await sdk.getApiOrders({})
console.log(orders.response?.status, orders.data?.orders?.length, 'orders')
```

## One client per user

Each `createSiteClient` call creates a client of its own and returns `{ sdk, client, jar, fetch }`,
so in a server app one instance per user or account never shares cookies, credentials or settings.
Call operations through the `sdk` it returns. The host namespaces exported from `index.ts` are the
unbound functions on hey-api's shared default client, which is left unconfigured on purpose:
called without `{ client }` they throw instead of sending a request without your session.

```ts
import { CookieJar, createSiteClient } from './api-handoff/client/index.js'

// One client per user of a server app: separate jars, separate credentials.
const alice = createSiteClient({
  host: 'localhost:4173',
  jar: new CookieJar()
})
const bob = createSiteClient({
  host: 'localhost:4173',
  jar: new CookieJar()
})
const { response } = await alice.sdk.getStores({})
console.log(response?.status, alice.jar !== bob.jar) // 200 true
```

Hosts that work with plain HTTP need no browser: leave out `session`, or use `tokenSession`. To
keep a session between runs, save `jar.toJSON()` and restore it with `CookieJar.fromJSON(saved)`.

## Small bundles

`createSiteClient` binds every function of every host into `sdk`, so a bundle that uses it holds
them all. Each host folder also has `site.ts`, with the host's own factory and its functions; a
bundler then keeps only what you import. On the fixture shop, where the deals page works over
plain HTTP:

```ts
import { extractDealsFromGetDeals } from './api-handoff/client/extract.js'
import { createLocalhost4173Client, getDeals } from './api-handoff/client/localhost_4173/site.js'

const { client } = createLocalhost4173Client()
const { data } = await getDeals({
  client,
  query: { page: 1 },
  parseAs: 'text'
})
console.log(extractDealsFromGetDeals(String(data)).length, 'deals')
```

The factory takes the same options as `createSiteClient` without `host`. Bundlers pick the
runtime's `browser` build, which parses HTML with `DOMParser` and bundles no HTML parser.

## GraphQL and dispatcher operations

GraphQL operations get a function each, named after the operation, that sends the operation name,
the persisted-query hash or the document itself; you pass only the variables, typed from the
capture: `await sdk.storeHours({ variables })`. GET operations encode `variables` as JSON in the
query string, as the site does.

Endpoints where one parameter picks the function (`?functionName=getStoreInfo`, `admin-ajax.php`
with `action=`, JSON-RPC `method`) get one function per captured value, which sends that parameter
itself: `await sdk.getStoreInfo({ query })`.

## Where it runs

- Node and Bun: everything works.
- Edge workers (Cloudflare Workers and the like): plain HTTP works. There is no file system and no
  browser, so store `jar.toJSON()` in the platform's storage, restore it on each request, and leave
  out `browserSession`.
- Browser: only from the site's own origin (an extension or a userscript on that site). From any
  other page the browser blocks the request or its answer (CORS), will not send the jar's cookies
  or set `Cookie`, `Referer` or `User-Agent`, and hides `Set-Cookie`. Call the site from your own
  backend instead.
