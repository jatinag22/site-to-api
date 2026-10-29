/**
 * Finds where the site's code computes a time-based one-time code (TOTP) that a request sends.
 * Spotify's web player sends `totp=180073` to `GET /api/token`: a 6-digit HMAC code built in the
 * page by a bundled OTP library, with no crypto call the capture's hooks see. The code shows it:
 * a generator configured with `digits` and a `period` or HMAC `algorithm`, and, in the same file,
 * an object that puts the code under the request field's name (`{ totp: i, totpServer: n }`).
 */
import type { ObjectExpression } from 'oxc-parser'
import type { LoadedSession, OneTimeCodeSite } from '../../model'
import type { CodeFile } from './files'
import { keyName, LineIndex, parseCode, walkWithFunctions } from './ast'
import { readSessionFile, siteCodeFiles } from './files'

/** Digits a one-time code has: 6 (RFC 6238 default) to 8. */
const MIN_DIGITS = 6
const MAX_DIGITS = 8
/** HMAC hash names an OTP generator is configured with. */
const HMAC_ALGORITHM = /^(?:hmac[-_]?)?sha-?(?:1|224|256|384|512)$/i

/** The literal value of an object's property, by name. */
function literalProperty(node: ObjectExpression, name: string): string | number | null {
  for (const property of node.properties) {
    if (property.type !== 'Property' || keyName(property.key) !== name)
      continue
    const value = property.value
    return value.type === 'Literal' && (typeof value.value === 'string' || typeof value.value === 'number')
      ? value.value
      : null
  }
  return null
}

/** The settings of an OTP generator config (`{ period: 30, algorithm: "SHA1", digits: 6 }`), or null. */
function generatorConfig(node: ObjectExpression): OneTimeCodeSite['config'] | null {
  const digits = literalProperty(node, 'digits')
  if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < MIN_DIGITS || digits > MAX_DIGITS)
    return null
  const period = literalProperty(node, 'period')
  const algorithm = literalProperty(node, 'algorithm')
  const hasPeriod = typeof period === 'number' && period > 0
  const hasAlgorithm = typeof algorithm === 'string' && HMAC_ALGORITHM.test(algorithm)
  if (!hasPeriod && !hasAlgorithm)
    return null
  return {
    digits,
    period: hasPeriod ? period : null,
    algorithm: hasAlgorithm ? algorithm : null,
  }
}

/** How many of the optional settings a config states. */
function completeness(config: OneTimeCodeSite['config']): number {
  return Number(config.period !== null) + Number(config.algorithm !== null)
}

/** The generator config and the wanted properties of one file; `null` when it has no generator. */
function scanFile(text: string, file: CodeFile, fields: ReadonlySet<string>): OneTimeCodeSite[] | null {
  const program = parseCode(file.path, text, file.kind === 'bundle')
  if (!program)
    return null
  let config: OneTimeCodeSite['config'] | null = null
  const properties: Array<{ field: string, at: number, functionName: string | null }> = []
  walkWithFunctions(program, current => ({
    ObjectExpression: (node) => {
      // A library's defaults (`{ digits: 6, algorithm: "SHA1", period }`) can come before the
      // site's own config; the one that states the most settings describes the code best.
      const candidate = generatorConfig(node)
      if (candidate !== null && (config === null || completeness(candidate) > completeness(config)))
        config = candidate
      for (const property of node.properties) {
        const name = property.type === 'Property'
          ? keyName(property.key)
          : null
        if (name !== null && fields.has(name)) {
          properties.push({
            field: name,
            at: property.start,
            functionName: current(),
          })
        }
      }
    },
  }))
  const settings: OneTimeCodeSite['config'] | null = config
  if (settings === null)
    return null
  const lines = new LineIndex(text)
  return properties.map(property => ({
    field: property.field,
    ref: {
      ...lines.position(property.at),
      file: file.path,
      functionName: property.functionName,
      original: file.kind === 'original',
      excerpt: null,
    },
    config: settings,
  }))
}

/**
 * For each wanted request field name, the first place (files in a fixed order) where a file that
 * configures an OTP generator writes an object property of that name. Fields of files without a
 * generator are not reported: a `code` property alone says nothing about how it was computed.
 */
export async function findOneTimeCodes(sessions: LoadedSession[], fields: ReadonlySet<string>): Promise<Map<string, OneTimeCodeSite>> {
  const found = new Map<string, OneTimeCodeSite>()
  if (fields.size === 0)
    return found
  const scanned = new Map<string, string>()
  for (const session of sessions) {
    for (const file of siteCodeFiles(session)) {
      const key = `${file.kind}:${file.host}:${file.path}`
      const text = await readSessionFile(session, file.file)
      // Cheap filter before parsing: a generator config always names its digits.
      if (text === null || scanned.get(key) === text || !text.includes('digits'))
        continue
      scanned.set(key, text)
      for (const site of scanFile(text, file, fields) ?? []) {
        if (!found.has(site.field))
          found.set(site.field, site)
      }
    }
  }
  return found
}
