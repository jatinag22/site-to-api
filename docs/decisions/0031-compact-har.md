# 0031 Compact the raw HAR: no asset bodies, no WebSocket frames

Status: Accepted (2026-10-29). Refines 0016 and 0023.

## Context
Playwright records the HAR with `content: 'embed'` and `mode: 'full'`: every response body, and
every WebSocket frame under `_webSocketMessages`. Real captures grew large fast: 32 MB in 40
seconds on Binance, 67 MB and 52 MB for two Nike sessions. WebSocket frames were suspected, but
they were 0.9 MB of Binance's 31 MB; the bulk was response bodies of scripts (stored a second
time under `scripts/`), images, video segments, fonts and stylesheets.

`build` reads none of those: frames come from the `ws` events in `events.jsonl` (decision 0023),
source analysis reads `scripts/`, and every entry whose resource type is image, font, stylesheet,
media or script is classified `asset` by its type alone and never traced. Playwright can filter
the HAR only by URL, not by type.

## Decision
- After the browser context closes and the HAR is validated, `capture` compacts it in place
  (`src/capture/har.ts`): it removes `_webSocketMessages` and the body text of entries whose
  `_resourceType` is image, font, stylesheet, media or script, keeping their size and media type
  and saying in the entry's `comment` that the body was omitted.
- Bodies of documents, fetch and XHR calls stay, whatever their media type: classification reads
  the media type and body of calls (a video segment fetched by XHR is an asset because of it),
  and analysis reads their content.
- The raw format version is unchanged: the result is still a HAR 1.2 file, and older captures
  with full bodies load as before.

## Consequences
On the real captures the HARs shrank from 31 MB to 16 MB (Binance) and from 67 MB and 52 MB to
24 MB and 9 MB (Nike), and `build` wrote the same handoff folder from the compacted files. The
HAR is no longer a complete record to open in browser tools: images and scripts show no
content. The size is still unbounded for sites with large JSON or HTML responses; a cap on
those would lose data that analysis reads, so none is set.
