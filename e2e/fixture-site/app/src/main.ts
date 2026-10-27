/** Entry point of the shop frontend: picks the page module from `<body data-page>`. */
import { trackPageView } from './analytics/track'
import { bindLoginForm } from './auth/login'
import { downloadPriceList } from './export/price-list'
import { requireElement } from './format'
import { renderAccountPage, renderOrdersPage } from './pages/account'
import { renderHomePage } from './pages/home'
import { renderProductPage } from './pages/product'
import { renderStorePage } from './pages/store'

function showFatalError(error: unknown): void {
  const banner = document.createElement('p')
  banner.setAttribute('role', 'alert')
  banner.textContent = `Something went wrong: ${error instanceof Error
    ? error.message
    : String(error)}`
  document.querySelector('main')?.prepend(banner)
}

async function startPage(): Promise<void> {
  const { page, productId, pollMs, store } = document.body.dataset
  switch (page) {
    case 'home':
      return renderHomePage()
    case 'product':
      return renderProductPage(Number(productId), Number(pollMs ?? '1500'))
    case 'store':
      return renderStorePage(store ?? '')
    case 'login':
      return bindLoginForm(requireElement('#login-form', HTMLFormElement))
    case 'account':
      return renderAccountPage()
    case 'orders':
      return renderOrdersPage()
    default:
      return undefined
  }
}

const analyticsOrigin = document.querySelector<HTMLMetaElement>('meta[name="analytics-origin"]')?.content
if (analyticsOrigin !== undefined)
  trackPageView(analyticsOrigin)
requireElement('#price-list-button', HTMLButtonElement).addEventListener('click', () => {
  downloadPriceList().catch(showFatalError)
})
startPage().catch(showFatalError)
