/** "Download price list": fetches the CSV export and saves it through a blob link. */
import { apiFetch } from '../api/client'

export async function downloadPriceList(): Promise<void> {
  const response = await apiFetch('/api/export.csv', {
    headers: { accept: 'text/csv' },
  })
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = 'pinewood-price-list.csv'
  document.body.append(link)
  link.click()
  link.remove()
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
