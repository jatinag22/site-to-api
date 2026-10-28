/**
 * Installs the instrumentation binding through the Chrome DevTools Protocol, so every call comes
 * with the security origin of the document that made it.
 *
 * Playwright's `exposeBinding` only says which frame called, and a frame's URL does not say whose
 * document is in it: a third-party iframe can navigate a same-origin sibling to `about:blank` and
 * call through it, and that document's origin is the third party's, not its parent's. CDP's
 * `Runtime.bindingCalled` names the exact JavaScript context that called, and
 * `Runtime.executionContextCreated` gives each context's origin as the browser enforces it, so
 * the check in `frames.ts` works on facts the page cannot change.
 *
 * Each page gets its own CDP session. A popup is attached when Playwright reports it, a moment
 * after its first scripts ran; the page code queues and retries until the binding is there.
 *
 * Known limitation: frames that Chromium runs in another process (cross-site iframes under site
 * isolation, and same-site ones that ask for origin-keyed isolation) are separate targets that
 * this page-level session does not reach, so they cannot report events at all. For cross-site
 * frames that is the scope rule anyway.
 */
import type { BrowserContext, CDPSession, Page } from 'playwright'
import type { FrameCall } from './frames'
import { acceptsCall, normalizeOrigin } from './frames'
import { BINDING_NAME } from './instrument'

/** What the binding hands to the session for each call. */
export interface BindingHandlers {
  /** A call from a document in scope: the message text and the caller's security origin. */
  accept: (text: string, frameOrigin: string) => void
  /** A call from a document out of scope, by its security origin (`'unknown'` if none). */
  ignore: (frameOrigin: string) => void
}

interface ContextInfo {
  origin: string
  frameId: string
}

/** Fields of CDP's `Runtime.ExecutionContextDescription.auxData` that Chromium always sets. */
interface AuxData {
  frameId?: unknown
  isDefault?: unknown
}

/** The page's main-world context for a frame, or `null` for isolated worlds and workers. */
function mainWorldFrame(auxData: AuxData | undefined): string | null {
  if (auxData === undefined || auxData.isDefault !== true || typeof auxData.frameId !== 'string')
    return null
  return auxData.frameId
}

/** Origin of an http(s) start URL, or `null` when the capture starts elsewhere. */
function startOrigin(url: string | null): string | null {
  if (url === null)
    return null
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol)
      ? parsed.origin
      : null
  }
  catch {
    return null
  }
}

/** The instrumentation binding for one capture: attach every page, get only in-scope calls. */
export class InstrumentBinding {
  private readonly attached = new WeakSet<Page>()
  private readonly site: string | null
  /** Security origin of the first page's top frame, the site when there is no start URL. */
  private firstTop = 'null'

  /**
   * @param context The capture's browser context, used to open a CDP session per page.
   * @param startUrl The capture's start URL; its origin is the site popups must belong to.
   */
  constructor(
    private readonly context: BrowserContext,
    startUrl: string | null,
    private readonly handlers: BindingHandlers,
  ) {
    this.site = startOrigin(startUrl)
  }

  /**
   * Installs the binding in `page` and starts listening to it. `first` marks the page the capture
   * opened, whose top frame is always listened to; every other page must be in scope of the site.
   * Attaching a page twice does nothing, and a page that closes while attaching is skipped.
   */
  async attach(page: Page, first: boolean): Promise<void> {
    if (this.attached.has(page))
      return
    this.attached.add(page)
    let session: CDPSession
    try {
      session = await this.context.newCDPSession(page)
    }
    catch {
      return
    }
    const contexts = new Map<number, ContextInfo>()
    let mainFrameId: string | null = null
    let top = 'null'

    session.on('Runtime.executionContextCreated', ({ context }) => {
      const frameId = mainWorldFrame(context.auxData)
      if (frameId === null)
        return
      const origin = normalizeOrigin(context.origin)
      contexts.set(context.id, { origin, frameId })
      if (frameId === mainFrameId) {
        top = origin
        if (first)
          this.firstTop = origin
      }
    })
    session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      contexts.delete(executionContextId)
    })
    session.on('Runtime.executionContextsCleared', () => {
      contexts.clear()
    })
    session.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
      if (name !== BINDING_NAME)
        return
      const caller = contexts.get(executionContextId)
      if (caller === undefined) {
        this.handlers.ignore('unknown')
        return
      }
      const call: FrameCall = {
        frameOrigin: caller.origin,
        mainFrame: caller.frameId === mainFrameId,
        firstPage: first,
        topOrigin: top,
        siteOrigin: this.site ?? this.firstTop,
      }
      if (acceptsCall(call))
        this.handlers.accept(payload, caller.origin)
      else
        this.handlers.ignore(caller.origin)
    })

    try {
      // The frame tree comes first so the contexts Runtime.enable replays can be told apart.
      mainFrameId = (await session.send('Page.getFrameTree')).frameTree.frame.id
      await session.send('Runtime.enable')
      await session.send('Runtime.addBinding', { name: BINDING_NAME })
    }
    catch {
      // The page closed while attaching; there is nothing left to listen to.
    }
  }
}
