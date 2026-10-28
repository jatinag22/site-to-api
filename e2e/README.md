# End-to-end tests and the fixture site

The end-to-end tests run the whole pipeline (capture → build → probe → gen) against
**Pinewood Market**, a fictional grocery shop served from this folder. Tests never touch real
websites: everything below runs on `localhost` and `127.0.0.1`, started by the test itself.

```
e2e/
  fixture-site/
    server.ts         startFixtureSite(): both origins, routing, the /api/* shield check
    catalog.ts        seeded catalogue: categories, products, reviews, stores, deals, orders
    auth.ts           CSRF tokens, RSA key, login, sessions, JWT-shaped bearer tokens
    shield.ts         toy bot protection shaped like Akamai (_abck, bm_sz, sensor_data)
    pages.ts          server-rendered HTML
    ticker.ts         /ws/ticker WebSocket
    bundle.ts         esbuild bundling of app/src at start-up
    static.ts         CSS, image and font assets
    app/src/          the shop frontend (TypeScript)
    site.test.ts      checks the site behaves, over plain HTTP and in headless Chromium
  scenarios/          capture "script mode" journeys (browse, browse-again, login)
```

## Running

Try the tool by hand against the shop (serves on `http://localhost:4173`, `PORT` to change):

```sh
pnpm --filter @site-to-api/e2e run fixture
```

Tests:

```sh
pnpm --filter @site-to-api/e2e exec playwright install chromium   # once
pnpm exec vitest --run --project e2e
```

```ts
import { startFixtureSite } from './fixture-site/server'

const site = await startFixtureSite({
  port: 0,
  now: () => Date.UTC(2026, 9, 28)
})
// site.origin          http://localhost:<port>    the shop
// site.secondaryOrigin http://127.0.0.1:<port2>   the "analytics" host
await site.close()
```

Options: `port`, `secondaryPort` (0 picks free ports), `seed` (default `20261028`), `now` (a fixed
clock for tokens and timestamps), `livePriceIntervalMs` (default 1500), `tickIntervalMs`
(default 1000).

**Determinism.** All data comes from a seeded generator, never `Math.random()`. The same seed
serves the same catalogue, and the same sequence of requests yields the same CSRF tokens,
session ids and `_abck` values. The one exception is the RSA key pair, which Node cannot derive
from a seed: it is generated on every start, so encrypted passwords differ between runs (they
would anyway, RSA-OAEP is randomised).

**Test account (fake).** Username `demo`, password `demo-password`. The scenarios type these into
the login form. They protect nothing.

## Endpoints and what each one exercises

Every `/api/*` call answers **403** unless it carries a valid `_abck` cookie from
`POST /shield/collect`.

| Endpoint | What it is | Tool feature it exercises |
|---|---|---|
| `GET /` | Home shell; categories and products load from the API | page classification, click actions that split flows |
| `GET /api/categories` | JSON list of categories | JSON schema inference |
| `GET /api/products?category=&page=` | Paged product list | query parameters, enums (`category`), values that vary across samples |
| `GET /api/products/{id}` | Product detail, numeric ids `1001`–`1024` | path parameters from numeric segments and source templates; `id` traced from the list response |
| `GET /api/products/{id}/reviews` | Reviews of a product | nested path parameters |
| `GET /api/products/{id}/related` | Referenced in `fetchRelatedProducts()` but only called by a button no scenario presses | `x-site-to-api-source-only` endpoints found in code |
| `GET /api/live-price?productId=` | Polled every `livePriceIntervalMs` on product pages | repeated identical requests, polling without person actions |
| `GET /login` | Login form; CSRF token in `<meta name="csrf-token">` and a hidden `_csrf` input | value origin `html` (token from the page into the `x-csrf-token` header) |
| `GET /api/auth/key` | RSA public key, SPKI base64 | value used by a computed value (`uses`) |
| `POST /api/auth/login` | JSON `{ username, password }`, header `x-csrf-token`; `password` is RSA-OAEP SHA-256 ciphertext from `encryptPassword()` in `app/src/auth/crypto.ts`. The server decrypts it. Answers `{ token, ... }` and `Set-Cookie: pm_session=...; HttpOnly` | `crypto.subtle.encrypt` transform hook, computed values with source excerpts, `user-input` origins, redaction of tokens and cookies |
| `GET /api/me`, `GET /api/orders` | Need **both** the `pm_session` cookie and `Authorization: Bearer <token>`; 401 otherwise | session requirements (`cookies` + `token`), token traced from the login response body |
| `GET /shield/sensor.js` | Toy sensor, minified, **no sourcemap** | bot-protection detection, bundles without sourcemaps (`bundles/<host>/...` excerpts) |
| `POST /shield/collect` | JSON `{ sensor_data }` → `Set-Cookie: _abck=...` | `bot-protection` kind, browser-only flow step, cookie `setBy` |
| `bm_sz` cookie | Set on every HTML page response | more vendor-shaped cookies for detection |
| `GET /deals?page=N` | Server-rendered table: name, price `₹1,299.00`, discount `15%`, link `/products/{id}`; pages 1–3 | HTML extraction: repeated records, number and percentage types, links, pagination |
| `GET /stores`, `GET /stores/{slug}` | Store index and details as a `<dl>` and as label `<span>`s; slugs `pine-hill`, `cedar-park`, `maple-cross`, `birch-lane` | HTML label/value extraction, template vs data comparison across slugs |
| `GET /api/export.csv` | CSV with a header row, downloaded by the "Download price list" button | `text/csv` responses and their extraction spec |
| `GET /api/stock.txt` | Pipe-delimited `id\|name\|status\|quantity` lines; needs the `pm_store` cookie, which only the store page's JavaScript sets (`document.cookie`) | `text/plain` extraction; cookie origin `script` (no response sets it, but its value traces to the store page, so a wrapper can set it) |
| `GET /ws/ticker` | WebSocket; client sends `{"type":"subscribe","productId":N}`, server pushes `tick` messages | WebSocket capture in both directions |
| `POST http://127.0.0.1:<port2>/collect`, `GET .../pixel.gif` | `navigator.sendBeacon` and a tracking pixel on a second host | `noise` classification, host filtering, `beacon` initiators |
| `/assets/site.css`, `/assets/logo.png`, `/assets/fonts/pinewood-sans.woff2` | Static assets (the font is a placeholder the browser downloads but cannot decode) | `asset` classification |
| `/assets/app.<hash>.js` | Main bundle: whitespace-minified, external sourcemap via `//# sourceMappingURL=` with `sourcesContent`, meaningful function names | sourcemap resolution, call sites in original `src/...` files |
| `/assets/ticker.js` | Ticker widget with an inline `data:` sourcemap | inline sourcemaps |

## Scenarios

Each file in `scenarios/` is a capture script-mode module:
`export default async function ({ page, baseUrl }): Promise<void>`. They click visible elements
and type like a person.

- `browse.ts`: home → Snacks → show more → first product → reviews → two live-price polls →
  deals page 1 → page 2 → Pine Hill and Cedar Park stores → download the CSV.
- `browse-again.ts`: the same journey with Beverages, the second product, deals pages 1–3 and the
  Maple Cross and Birch Lane stores, so every operation has a second, different sample.
- `login.ts`: home → Sign in → type the demo credentials → submit → My orders.

`scenarios/lib/journey.ts` holds the journey shared by the two browse scenarios.
