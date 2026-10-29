/**
 * The shopping journey shared by `browse.ts` and `browse-again.ts`. Every step is a click on a
 * visible element, the way a person would move through the site, so the capture records real
 * actions to split flows at.
 */
import type { Page } from 'playwright'

export interface JourneyChoices {
  /** Category button label on the home page. */
  category: string
  /** Which product card of that category to open, counting from 0. */
  productIndex: number
  /** How many times to press "Next page" on the deals table. */
  dealPagesToTurn: number
  /** Two store links to open, by their link text. */
  stores: [string, string]
}

/** Waits until `count` more live-price polls have been answered. */
async function waitForLivePricePolls(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++)
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/live-price' && response.ok())
}

/**
 * Runs the journey: home → category → product → reviews → wishlist → live prices → deals →
 * stores → CSV.
 */
export async function shoppingJourney(page: Page, baseUrl: string, choices: JourneyChoices): Promise<void> {
  await page.goto(baseUrl)
  await page.waitForLoadState('networkidle')

  await page.getByRole('button', { name: choices.category, exact: true }).click()
  const grid = page.locator('#product-grid')
  await grid.getByRole('link').nth(choices.productIndex).waitFor()
  await page.getByRole('button', { name: 'Show more products' }).click()
  await grid.getByRole('link').nth(3).waitFor()

  await grid.getByRole('link').nth(choices.productIndex).click()
  await page.locator('#product-name').filter({ hasNotText: 'Loading' }).waitFor()
  await page.getByRole('button', { name: 'Read reviews' }).click()
  await page.locator('#reviews li').first().waitFor()
  await page.locator('#product-stock').filter({ hasText: 'in' }).waitFor()
  await page.getByRole('button', { name: 'Add to wishlist' }).click()
  await page.locator('#wishlist-status').filter({ hasText: 'Saved' }).waitFor()
  await waitForLivePricePolls(page, 2)
  // The ticker socket opens on its own schedule. Leaving the page before its first tick can drop
  // the connection from the capture, so wait for one: each journey then records one connection.
  await page.locator('#ticker').filter({ hasText: /\(tick \d+\)/ }).waitFor()

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Deals' }).click()
  await page.locator('table.deals tbody tr').first().waitFor()
  for (let turn = 0; turn < choices.dealPagesToTurn; turn++) {
    await page.getByRole('link', { name: 'Next page' }).click()
    await page.getByText(`Page ${turn + 2} of`).waitFor()
  }

  for (const store of choices.stores) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Stores' }).click()
    await page.getByRole('link', { name: store }).click()
    await page.locator('#store-stock li').first().waitFor()
    await page.locator('#store-hours-live').filter({ hasText: 'Open now' }).waitFor()
    await page.locator('#store-info-live').filter({ hasText: 'Manager:' }).waitFor()
  }

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download price list' }).click()
  await (await download).path()
  await page.waitForLoadState('networkidle')
}
