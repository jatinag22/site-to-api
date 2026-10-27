/** Display helpers shared by the pages. */

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 })

export function formatPrice(value: number): string {
  return inr.format(value)
}

/** Creates an element with text content, so API data is never parsed as HTML. */
export function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

export function requireElement<T extends Element>(selector: string, type: new () => T): T {
  const element = document.querySelector(selector)
  if (!(element instanceof type))
    throw new TypeError(`missing element ${selector}`)
  return element
}
