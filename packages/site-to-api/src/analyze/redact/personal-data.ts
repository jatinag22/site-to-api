/**
 * Personal-data detectors. Each match is masked keeping its format (separators, length, the kind
 * of character), so a reader still sees "this is a card number" without the number.
 */

/** Letters become `X`/`x`, digits `0`; everything else is kept. */
export function maskKeepingFormat(value: string): string {
  return value.replace(/[A-Z]/g, 'X').replace(/[a-z]/g, 'x').replace(/\d/g, '0')
}

/** Luhn checksum used by payment card numbers. */
export function isLuhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9)
        digit -= 9
    }
    sum += digit
    double = !double
  }
  return digits.length > 0 && sum % 10 === 0
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

/** Verhoeff checksum used by Aadhaar numbers. */
export function isVerhoeffValid(digits: string): boolean {
  let check = 0
  const reversed = [...digits].reverse()
  for (const [index, char] of reversed.entries())
    check = VERHOEFF_D[check]![VERHOEFF_P[index % 8]![Number(char)]!]!
  return digits.length > 0 && check === 0
}

const onlyDigits = (value: string): string => value.replace(/\D/g, '')

export interface PersonalDataPattern {
  name: string
  regex: RegExp
  /** Extra check on a match, e.g. a checksum. */
  accept?: (match: string) => boolean
}

/** Built-in detectors, applied in this order. */
export const PERSONAL_DATA_PATTERNS: readonly PersonalDataPattern[] = [
  {
    name: 'email',
    regex: /[\w.%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  },
  {
    // Indian Permanent Account Number: five letters, four digits, one letter.
    name: 'pan',
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  },
  {
    // Aadhaar: 12 digits, optionally grouped 4-4-4, never starting with 0 or 1, Verhoeff checksum.
    name: 'aadhaar',
    regex: /\b[2-9]\d{3}([ -]?)\d{4}\1\d{4}\b/g,
    accept: match => isVerhoeffValid(onlyDigits(match)),
  },
  {
    // Payment cards: 13-19 digits from the major networks (first digit 2-6), Luhn checksum.
    // The first-digit rule keeps millisecond timestamps (they start with 1) out.
    name: 'card',
    regex: /\b[2-6]\d{3}(?:[ -]?\d){9,15}\b/g,
    accept: (match) => {
      const digits = onlyDigits(match)
      return digits.length >= 13 && digits.length <= 19 && isLuhnValid(digits)
    },
  },
  {
    // International phone numbers written with a leading +.
    name: 'phone',
    regex: /(?<![\w+])\+\d[\d\s().-]{6,18}\d/g,
    accept: (match) => {
      const digits = onlyDigits(match).length
      return digits >= 8 && digits <= 15
    },
  },
]

const PHONE_FIELD = /phone|mobile|msisdn|whatsapp|(?:^|[^a-z])tel(?:[^a-z]|$)|contact[-_]?no/i

/** Field names whose values are phone numbers even without a leading `+`. */
export function isPhoneField(name: string | null | undefined): boolean {
  return name !== null && name !== undefined && PHONE_FIELD.test(name)
}

/** Masks every personal-data match in a text. */
export function maskPersonalData(text: string, patterns: readonly PersonalDataPattern[]): string {
  let result = text
  for (const pattern of patterns) {
    result = result.replace(pattern.regex, match =>
      (pattern.accept === undefined || pattern.accept(match))
        ? maskKeepingFormat(match)
        : match)
  }
  return result
}

/** Masks a whole value that sits in a phone-number field. */
export function maskPhoneField(value: string): string | null {
  const digits = onlyDigits(value).length
  if (digits < 7 || digits > 15 || /[a-z]/i.test(value))
    return null
  return maskKeepingFormat(value)
}
