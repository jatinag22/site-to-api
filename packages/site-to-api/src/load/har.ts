/**
 * Minimal Zod schema for the parts of HAR 1.2 that `load` reads. Playwright and Chrome DevTools
 * both write these fields; everything else in the file is ignored.
 */
import { z } from 'zod'

const HarNameValueSchema = z.object({
  name: z.string(),
  value: z.string(),
})

const HarCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  path: z.string().nullish(),
  domain: z.string().nullish(),
  expires: z.string().nullish(),
  httpOnly: z.boolean().nullish(),
  secure: z.boolean().nullish(),
  sameSite: z.string().nullish(),
})
export type HarCookie = z.infer<typeof HarCookieSchema>

export const HarEntrySchema = z.object({
  startedDateTime: z.string(),
  /** Chrome DevTools and some Playwright versions record the resource type here. */
  _resourceType: z.string().nullish(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.array(HarNameValueSchema),
    cookies: z.array(HarCookieSchema).nullish(),
    postData: z.object({
      mimeType: z.string().nullish(),
      text: z.string().nullish(),
      params: z.array(z.object({
        name: z.string(),
        value: z.string().nullish(),
        fileName: z.string().nullish(),
      })).nullish(),
    }).nullish(),
  }),
  response: z.object({
    status: z.number(),
    statusText: z.string().nullish(),
    headers: z.array(HarNameValueSchema),
    cookies: z.array(HarCookieSchema).nullish(),
    content: z.object({
      mimeType: z.string().nullish(),
      text: z.string().nullish(),
      encoding: z.string().nullish(),
    }).nullish(),
  }),
})
export type HarEntry = z.infer<typeof HarEntrySchema>

/** Entries are validated one by one so a single odd entry becomes a warning, not a failure. */
export const HarFileSchema = z.object({
  log: z.object({
    entries: z.array(z.unknown()),
  }),
})
