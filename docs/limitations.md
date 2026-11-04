# Known limitations

What `site-to-api` does not do, or does only partly. The README lists the four a first run is most
likely to meet; this page has all of them.

## Capture and import

- Web Workers and Service Workers are not instrumented (their traffic is captured, without stacks).
- An imported HAR cannot explain values the page computed: it has no typed inputs, no crypto calls
  and, unless the HAR has them, no call stacks or scripts. Capture the same pages for that.
- Interactive capture (closing the window to finish) is covered by an abort test but not by an
  automated headful test. In interactive mode a browser crash looks like quitting; both save a
  complete session with a note.
- A flow step is marked as sent after a dialog (`dialogs` in `flows.json`, decision 0064) by
  timing: the first step request of the dialog's page that started within 2 seconds of the person
  accepting it. A guarded request the page sent later than that (after a slow animation or a
  second round trip) is not marked, and a step whose request happened to follow a dialog it does
  not depend on can be, as can a request the page sent between the click and the dialog (a check
  before asking). Dialogs in other tabs of the same page URL are not told apart. The person
  answering Chrome's own dialog in a headed capture is checked by hand (docs/testing.md), not by
  an automated test.
- A saved profile (`--user-data-dir`) keeps cookies that outlive the browser. A login the site
  keeps in session storage or in session cookies does not survive between captures.

## Redaction

- Redaction and value tracing are heuristics. Personal data with no telling field name or shape
  (a name in a free-text bio) can get through. Review the handoff folder before publishing it.
- The build's leak check searches only for values the redactor learnt, and only those of 6 or more
  characters that mix letters and digits.
- A learnt value inside a host name (`<user>.github.io`) is not templated; the leak check stops
  that build instead.

## Analysis

- HTML and text extraction from a single sample is low confidence; capture a second pass.
- An enum needs its values seen in at least two sessions; from one session a field stays a plain
  string.
- GraphQL operations are split by operation name, persisted hash or document, but values inside
  GET `variables` are traced only as the whole query value, and an operation whose type neither
  the capture nor the site's code shows stays `unknown` (probe skips it). GraphQL subscriptions
  over WebSockets are documented as channels, not split by operation.
- Dispatcher endpoints are split only on evidence (different parameters or response shapes per
  value); functions the capture never called are not listed, and POST functions are not probed
  unless `--unsafe-methods`.
- Path templating can merge two endpoints whose code-route parameter has a minified name and
  whose words also appear in page text (YouTube's `/youtubei/v1/{qsa}`), and a site whose own
  API host is named `analytics.*` or `telemetry.*` is ranked last.
- Not decoded: fetch streams that never end, zstd request bodies, binary Connect bodies,
  gRPC-web, tRPC over WebSocket, encrypted SmartFoxServer packets.

## Generated client

- The generated code covers HTTP only; WebSocket channels are documented in AsyncAPI, to open with
  any WebSocket client.
- On a network without working IPv6, Node's `fetch` gives up on a distant host's IPv4 address
  after 250 ms (`ETIMEDOUT`) where `curl` connects. The CLI's own requests allow a second per
  attempt; an app using the generated client in Node sets this itself, with
  `net.setDefaultAutoSelectFamilyAttemptTimeout(1000)` or
  `--network-family-autoselection-attempt-timeout=1000`.

## Testing

- Tested by hand on about 30 public sites logged out (see [testing.md](testing.md)) and on two
  logged-in sessions; other kinds of site may still show new problems.
