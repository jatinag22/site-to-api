/** Page-view analytics sent to a separate origin: pure noise for the tool to filter out. */

/** Sends a beacon and loads a tracking pixel from `analyticsOrigin`. */
export function trackPageView(analyticsOrigin: string): void {
  const payload = JSON.stringify({ event: 'page_view', path: location.pathname, title: document.title })
  navigator.sendBeacon(`${analyticsOrigin}/collect`, payload)
  const pixel = new Image(1, 1)
  pixel.src = `${analyticsOrigin}/pixel.gif?e=page_view&p=${encodeURIComponent(location.pathname)}`
}
