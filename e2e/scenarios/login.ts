/**
 * Capture scenario: sign in with the fake demo account and open the order history. The password
 * is encrypted in the page before it is sent.
 */
import type { Page } from 'playwright'

/** Fake test credentials, documented in `e2e/README.md`. */
const USERNAME = 'demo'
const PASSWORD = 'demo-password'

export default async function login({ page, baseUrl }: { page: Page, baseUrl: string }): Promise<void> {
  await page.goto(baseUrl)
  await page.waitForLoadState('networkidle')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' }).click()

  await page.getByLabel('Username').pressSequentially(USERNAME, { delay: 20 })
  await page.getByLabel('Password').pressSequentially(PASSWORD, { delay: 20 })
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.getByRole('heading', { name: /^Welcome, / }).waitFor()
  await page.getByRole('link', { name: 'My orders' }).click()
  await page.locator('#orders tbody tr').first().waitFor()
  await page.waitForLoadState('networkidle')
}
