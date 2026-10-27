/**
 * Capture scenario: browse snacks, open the first product and its reviews, watch the live price,
 * page through deals, visit two stores and download the price list.
 */
import type { Page } from 'playwright'
import { shoppingJourney } from './lib/journey'

export default async function browse({ page, baseUrl }: { page: Page, baseUrl: string }): Promise<void> {
  await shoppingJourney(page, baseUrl, {
    category: 'Snacks',
    productIndex: 0,
    dealPagesToTurn: 1,
    stores: ['Pinewood Market Pine Hill', 'Pinewood Market Cedar Park'],
  })
}
