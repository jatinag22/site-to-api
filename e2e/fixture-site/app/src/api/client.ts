/**
 * Fetch wrapper used by every API call of the shop. Waits for the shield cookie first, because
 * the server rejects `/api/*` calls without it.
 */
import type { z } from 'zod'

/** An API call that did not return 2xx. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function waitForShield(): Promise<void> {
  if (window.pmShield === undefined)
    throw new Error('the shield sensor script did not load')
  await window.pmShield.ready
}

/** Sends a request after the shield is ready and fails on non-2xx answers. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await waitForShield()
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok)
    throw new ApiError(response.status, `${init.method ?? 'GET'} ${path} failed with ${response.status}`)
  return response
}

/** GETs JSON and validates it with `schema`. */
export async function getJson<T extends z.ZodType>(path: string, schema: T, headers: Record<string, string> = {}): Promise<z.output<T>> {
  const response = await apiFetch(path, {
    headers: { accept: 'application/json', ...headers },
  })
  return schema.parse(await response.json())
}

/** POSTs a JSON body and validates the JSON answer with `schema`. */
export async function postJson<T extends z.ZodType>(path: string, body: unknown, schema: T, headers: Record<string, string> = {}): Promise<z.output<T>> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return schema.parse(await response.json())
}
