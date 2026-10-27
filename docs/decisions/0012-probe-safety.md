# 0012 Probe only safe methods by default, rate limited

Status: Accepted (2026-10-28)

## Decision
`probe` replays captured requests to learn what works without a browser and which headers and
cookies are required. Defaults: GET/HEAD/OPTIONS only, 1 request per second, a bounded number of
variants per operation. `--unsafe-methods` must be passed explicitly to replay POST/PUT/PATCH/
DELETE, because they can change data on the live site.
