# 0049 Compressed request bodies, server-sent event streams, and pages next to service workers

Status: Accepted (2026-10-30). Refines 0023, 0031, 0036, 0037, 0038, 0044, 0046.

## Context
A matrix run on fourteen real sites found three gaps.

- **YouTube** gzips every innertube request body before `fetch` sends it (`content-encoding:
  gzip`). Playwright writes a HAR request body as UTF-8 text (and leaves it empty for
  `application/octet-stream`), so the HAR held replacement characters, the instrumentation's
  `bodyPreview` was empty (the page passes a `Request` object), and the spec of the site's main
  API said `requestBody: type: string`. The `content-encoding` header was then listed as an input
  of unknown origin, and a replay would have sent a decoded body labelled gzip.
- **Server-sent events** (Wikimedia EventStreams) were invisible: an `EventSource` stream never
  ends, so the HAR has no body for it, and the page's events reach only the listeners it
  registered. probe and check read every body to its end and reported the host "unreachable
  (timed out)". Replays also sent the browser's `If-None-Match`; the server answered 304, which
  probe read as a rejection and check as drift (200 → 304).
- **YouTube** navigations (`/`, `/watch`, `/@channel`) were API operations: its service worker
  fetches the same HTML, and any data call made a group `api` (0046). With no page operations the
  host ranking counted every host as the site's own, and `fonts.gstatic.com`, with 102 icon
  fetches, came first in `AGENT.md`. The capture also ended "incomplete" because the browser
  context did not finish closing within 30 s, although every page had closed and Playwright then
  wrote the whole HAR.

## Decision
- **Raw request bodies.** Capture keeps the bytes of each request body that is not valid UTF-8
  (`request.postDataBuffer()`, at most 2 MB) and, once the browser has written the HAR, adds them
  to the matching entry as `postData._base64` (matched by method, URL and byte size, in order;
  only entries whose text Playwright garbled or left empty). The field is additive: older readers
  ignore it, older captures do not have it, so the raw format version stays 1. `load` decodes the
  bytes by the request's `content-encoding` (`gzip`, `x-gzip`, `deflate` with or without the
  zlib wrapper, `br`, `identity`, several in reverse order), refusing output over 8 MB (zip-bomb
  guard, zlib `maxOutputLength`); once decoded, the header is dropped from the exchange, so it is
  neither documented, replayed nor traced. Value tracing also never traces `content-encoding`.
- **Event streams as channels.** Capture listens on each page's DevTools protocol for
  `Network.eventSourceMessageReceived` and writes an `sse` event per event an `EventSource`
  receives: URL, stream number, event name (`message` when none), id, data cut to 64 KB, at most
  2,000 events per stream (a warning says how many more were dropped). It is part of
  `capture.websockets` (real-time channels). The `sse` event is a new, additive member of the
  capture event union. The channels stage turns each stream into a connection whose events are
  received frames, plus each `text/event-stream` response the HAR holds a body for (a `fetch`
  stream that ended) that no reported stream matched. They are read only with the `sse` decoder
  (no WebSocket protocol applies), which names messages by their `event:` field and reads `data`
  as JSON when it is JSON. The channel's scheme is `http`/`https`, its transport `sse`, its
  "upgrade" the stream's GET (accepted on a 2xx), and `AGENT.md` and the host file say how to
  open and resume it (`EventSource`, `Last-Event-ID`). The AsyncAPI server protocol is the scheme.
- **probe and check read streams by their start.** A `text/event-stream` or NDJSON answer counts
  as answered once its headers and first event (a blank line; a newline for NDJSON) arrive, at
  most 10 s and 64 KB after the headers; the connection is then closed and the length is not
  compared with the capture. The request timeout covers only the wait for the headers. Replays
  never send `If-None-Match` or `If-Modified-Since`.
- **Pages.** A group of exchanges with a top-level navigation stays a page when the other
  members only fetched HTML or got no body (a service worker serving the navigation, a
  prefetch); a call that returned data still makes it an API operation. When a build has no page
  operations at all, the sessions' start URLs (now in the analysis as `startUrls`) name the
  site's own hosts; only without them is every host the site's own.
- **A browser that lingers after its pages.** When every page closed, the context's close timed
  out, and it finished once the browser was ended (so Playwright wrote the HAR), the session is
  complete, with a warning that the browser had to be ended. A page that never closed keeps the
  session incomplete.

- **The person's IP address.** Decoded innertube bodies carry the visitor's public IP
  (`context.client.remoteHost`), and YouTube's `sw.js_data` array holds it without a field
  name. Fields named `ip`, `ipAddress`, `remoteHost`, `remoteAddr`, `remoteIp` are personal
  fields (masked keeping their format), and a public IPv4 address is masked wherever it appears
  as text (not after `/`, `.`, `v` or a word character, so `Chrome/156.0.0.0` and `v1.2.3.4`
  stay; private, loopback, link-local, CGNAT and multicast addresses and `.0` networks stay).
- **Muted capture browser.** Captures of YouTube and similar sites played sound on the machine
  running them. The browser now starts with Chrome's `--mute-audio` unless
  `capture.browser.muteAudio` is false. Muting changes no network traffic: media still loads and
  plays, only without sound.

## Consequences
- YouTube's innertube calls get request-body schemas, examples and traced inputs; the agent sees
  the search query and the `context` object.
- A stream that a page opens with `fetch` and never ends is still not recorded (no HAR body, no
  DevTools event): only `EventSource` streams and streams that ended during capture are.
- Event names and data are site data: they go through the redactor like WebSocket frames, and
  the 2,000-event cap bounds what one stream costs in `events.jsonl`.
- `zstd` request bodies are kept as base64 with their header: Node 22.12 has no zstd decoder.
