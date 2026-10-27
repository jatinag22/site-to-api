/**
 * Names of generated client symbols. They come from hey-api's own `toCase`, the function it uses
 * when generating (decision 0010), so documents point at symbols that `gen` really produces.
 * Checked against hey-api 0.99.0 output: SDK function = camelCase(operationId), response schema
 * = `z` + PascalCase(operationId) + `Response`.
 */
import { toCase } from '@hey-api/shared'

/** The SDK function hey-api generates for an operation. */
export function sdkFunctionName(operationId: string): string {
  return toCase(operationId, 'camelCase')
}

/** The Zod schema hey-api generates for an operation's successful response. */
export function responseSchemaName(operationId: string): string {
  return `z${toCase(operationId, 'PascalCase')}Response`
}

/** File name used for a host's spec and client folder (`www.example.com` → `www_example_com`). */
export function hostSlug(host: string): string {
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}
