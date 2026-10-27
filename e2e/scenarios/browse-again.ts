/**
 * Capture scenario: the same journey as `browse.ts` with a different category, product, deal
 * pages and stores, so the tool gets a second sample of every operation.
 */
import type { Page } from 'playwright'
import { shoppingJourney } from './lib/journey'

export default async function browseAgain({ page, baseUrl }: { page: Page, baseUrl: string }): Promise<void> {
  await shoppingJourney(page, baseUrl, {
    category: 'Beverages',
    productIndex: 1,
    dealPagesToTurn: 2,
    stores: ['Pinewood Market Maple Cross', 'Pinewood Market Birch Lane'],
  })
}
