/**
 * Which frames may report instrumentation events.
 *
 * The binding reaches every document in a page, including third-party iframes (ads, embedded
 * widgets, a hostile page's own iframes) and popups, and any of them could send forged requests,
 * actions or response bodies. Only documents that belong to the site being captured are listened
 * to.
 *
 * Scope is judged by the calling document's security origin as the browser reports it (see
 * `binding.ts`), never by its URL: an `about:blank` document has the origin of whoever navigated
 * it there, which need not be its parent, so a URL-based guess can be borrowed by a third party.
 *
 * Rule ({@link acceptsCall}): in the first page, the top frame is always accepted (the person may
 * browse anywhere in it), and another frame is accepted when it is in scope of the current top
 * frame ({@link isFrameInScope}: same origin, or both http(s) with the same {@link registrableHost}).
 * In any other page (a popup), every frame, the top one included, must be in scope of the capture's
 * site: the start URL, or the first page's top frame when there is no start URL. Everything else
 * is ignored and counted in a capture warning.
 */
import { registrableHost } from '../hosts'

/**
 * A security origin as the browser reports it, in the form `URL.origin` uses: `scheme://host[:port]`
 * for tuple origins, `'null'` for opaque ones (Chromium reports those as `://`), sandboxed
 * documents and anything unparsable.
 */
export function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin
  }
  catch {
    return 'null'
  }
}

/** One call of the binding, described by the security origins involved. */
export interface FrameCall {
  /** Security origin of the calling document. */
  frameOrigin: string
  /** The caller is the top frame of its page. */
  mainFrame: boolean
  /** The caller's page is the one the capture opened first. */
  firstPage: boolean
  /** Security origin of the top frame of the caller's page, `'null'` when unknown. */
  topOrigin: string
  /** Origin of the capture's site: the start URL's, else the first page's top frame's. */
  siteOrigin: string
}

/** True when a binding call should be recorded; the rule is described at the top of this file. */
export function acceptsCall(call: FrameCall): boolean {
  if (call.firstPage)
    return call.mainFrame || isFrameInScope(call.frameOrigin, call.topOrigin)
  return isFrameInScope(call.frameOrigin, call.siteOrigin)
}

/** True when events from a frame with `frameOrigin` should be recorded for a top frame with `topOrigin`. */
export function isFrameInScope(frameOrigin: string, topOrigin: string): boolean {
  if (frameOrigin === topOrigin)
    return frameOrigin !== 'null'
  let frame: URL
  let top: URL
  try {
    frame = new URL(frameOrigin)
    top = new URL(topOrigin)
  }
  catch {
    return false
  }
  const web = /^https?:$/
  if (!web.test(frame.protocol) || !web.test(top.protocol))
    return false
  return registrableHost(frame.hostname) === registrableHost(top.hostname)
}
