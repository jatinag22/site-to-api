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

/** Lower-case name with separators removed: `display_name`, `displayName` → `displayname`. */
function compactName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Lower-case words of a name: `shippingAddress` → `[shipping, address]`. */
function words(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word !== '')
}

/**
 * Whole names (separators removed) of per-person tracking identifiers: Google Analytics `cid`,
 * `uid` and `_ga`, Adobe `ecid`/`mcid`. Too short to match as word endings (`acid`, `guid`).
 */
const TRACKING_NAMES: ReadonlySet<string> = new Set([
  'cid',
  'uid',
  'ga',
  'ecid',
  'mcid',
])

/**
 * Last words of tracking identifier names, separators removed: `x-nike-visitorid`,
 * `visitor_id`, `deviceId`, `anonymousId`, `adobeMarketingCloudId`.
 */
const TRACKING_NAME_ENDINGS: readonly string[] = [
  'visitorid',
  'deviceid',
  'anonymousid',
  'anonid',
  'clientid',
  'browserid',
  'trackingid',
  'marketingcloudid',
  'experiencecloudid',
]

/**
 * Names of identifiers that follow one visitor, browser or device across requests (decision
 * 0045): `visitorId`, `x-nike-visitorid`, `deviceId`, `anonymousId`, `clientId`, `cid`, `uid`.
 * Their values are per-person, so they are masked unless identical in every session, where they
 * are the site's own constant (an OAuth client id), as publishable keys are. Session ids are
 * secrets by name already ({@link isSecretName}).
 */
export function isTrackingIdName(name: string | null | undefined): boolean {
  if (name === null || name === undefined || name === '')
    return false
  if (TRACKING_NAMES.has(compactName(name)))
    return true
  const parts = words(name)
  return parts.map((_, index) => parts.slice(index).join('')).some(tail => TRACKING_NAME_ENDINGS.includes(tail))
}

/** Whole names (separators removed) of fields that identify a person or their account. */
const PERSONAL_NAMES: ReadonlySet<string> = new Set([
  'login',
  'loginid',
  'loginname',
  'zip',
  'pincode',
  'dob',
])

/**
 * Last words of personal field names, separators removed: `billingCity`, `user_name`,
 * `shippingAddress`. Matched on word boundaries, so `velocity` is not a city.
 */
const PERSONAL_NAME_ENDINGS: readonly string[] = [
  'username',
  'displayname',
  'firstname',
  'lastname',
  'fullname',
  'givenname',
  'familyname',
  'middlename',
  'nickname',
  'address',
  'addressline1',
  'addressline2',
  'street',
  'city',
  'postcode',
  'postalcode',
  'zipcode',
  'birthdate',
  'dateofbirth',
  'birthday',
  'userid',
  'customerid',
  'accountid',
  'memberid',
  // Other players in a game feed (decision 0048): their ids, names and chosen pictures.
  'playerid',
  'playername',
  'profileimage',
  'profileimages',
  'profilepicture',
  'profilephoto',
  'avatar',
  'avatars',
  'avatarurl',
]

/**
 * Field names whose values are a person's name, account or address, wherever they appear:
 * `username`, `user_name`, `login`, `displayName`, `firstName`, `lastName`, `fullName`,
 * `address`, `street`, `city`, `postcode`, `zip`, `dob`, `birthDate`, account and player ids
 * (`userId`, `player_id`) and profile pictures (`profileImage`, `avatarUrl`). Phone fields have their own rule ({@link isPhoneField}).
 */
export function isPersonalField(name: string | null | undefined): boolean {
  if (name === null || name === undefined || name === '')
    return false
  if (PERSONAL_NAMES.has(compactName(name)))
    return true
  const parts = words(name)
  const tails = parts.map((_, index) => parts.slice(index).join(''))
  return tails.some(tail => PERSONAL_NAME_ENDINGS.includes(tail))
}

/** Whole names (separators removed) of fields holding the browser's identity. */
const FINGERPRINT_NAMES: ReadonlySet<string> = new Set([
  'ua',
  'useragent',
  'deviceinfo',
  'browserinfo',
])

/** Last words of such names: `navigatorUserAgent`, `client_device_info`. */
const FINGERPRINT_NAME_ENDINGS: readonly string[] = [
  'useragent',
  'deviceinfo',
  'browserinfo',
]

/**
 * Body, query and form fields that hold the browser's user agent or device description
 * (`userAgent`, `ua`, `deviceInfo`): together with the rest of a capture they fingerprint the
 * person who captured it (decision 0048). The `User-Agent` header has its own rules.
 */
export function isFingerprintField(name: string | null | undefined): boolean {
  if (name === null || name === undefined || name === '')
    return false
  if (FINGERPRINT_NAMES.has(compactName(name)))
    return true
  const parts = words(name)
  return parts.map((_, index) => parts.slice(index).join('')).some(tail => FINGERPRINT_NAME_ENDINGS.includes(tail))
}

/** Name words of custom headers that carry the browser's device or ad signals. */
const DEVICE_SIGNAL_WORDS: ReadonlySet<string> = new Set([
  'device',
  'signals',
  'adsignals',
  'fingerprint',
  'screen',
  'viewport',
])

/**
 * Standard request headers with their own rules, which the tool may report as required: client
 * hints (`sec-ch-*`, `device-memory`, `dpr`, `viewport-width`), `user-agent`, `accept*`.
 */
const STANDARD_HEADER = /^(?:sec-ch-|user-agent$|accept|content-|device-memory$|dpr$|viewport-width$|width$)/i

/**
 * Custom headers whose name says they carry device or ad-signal data: YouTube's
 * `x-youtube-device` and `x-youtube-ad-signals` (decision 0049). Standard headers never count.
 */
export function isDeviceSignalHeader(name: string | null | undefined): boolean {
  if (name === null || name === undefined || name === '' || STANDARD_HEADER.test(name))
    return false
  const parts = words(name)
  return parts.some(part => DEVICE_SIGNAL_WORDS.has(part)) || parts.join('').includes('adsignal')
}

/**
 * Parameter names of device and ad signals: screen sizes (`u_h`, `u_w`, `biw`, `brdim`), time
 * zone (`u_tz`), history length (`u_his`), browser and OS (`cbr`, `cosver`, `cplatform`).
 */
const DEVICE_SIGNAL_KEYS: ReadonlySet<string> = new Set([
  'u_tz',
  'u_his',
  'u_h',
  'u_w',
  'u_ah',
  'u_aw',
  'u_cd',
  'bih',
  'biw',
  'brdim',
  'cbr',
  'cbrand',
  'cbrver',
  'ceng',
  'cengver',
  'cos',
  'cosver',
  'cplatform',
  'tz',
  'timezone',
  'screen',
  'sw',
  'sh',
])
const MIN_DEVICE_SIGNAL_KEYS = 2

function parameterNames(value: string): string[] {
  if (!value.includes('='))
    return []
  return value.split('&').map(pair => pair.split('=')[0] ?? '').filter(name => name !== '')
}

/** True when a value is URL-encoded parameters, two or more of them device or ad signals. */
export function carriesDeviceSignals(value: string): boolean {
  return parameterNames(value).filter(name => DEVICE_SIGNAL_KEYS.has(name.toLowerCase())).length >= MIN_DEVICE_SIGNAL_KEYS
}

/**
 * A device or ad-signal value with its data masked keeping the format: parameter names stay so a
 * reader sees what the site collects (`u_tz=000&u_his=0`); any other value is masked whole.
 */
export function maskDeviceSignals(value: string): string {
  if (parameterNames(value).length === 0)
    return maskKeepingFormat(value)
  return value.split('&').map((pair) => {
    const equals = pair.indexOf('=')
    return equals === -1
      ? pair
      : `${pair.slice(0, equals)}=${maskKeepingFormat(pair.slice(equals + 1))}`
  }).join('&')
}

/** Words of a property name that say the object under it describes a person or their account. */
const PERSON_OBJECT_WORDS: ReadonlySet<string> = new Set([
  'user',
  'users',
  'account',
  'accounts',
  'profile',
  'profiles',
  'customer',
  'customers',
  'me',
])

/** Fields that identify a person only inside a person's record: `user.name`, `customer.id`. */
const PERSON_RECORD_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'id',
])

/**
 * Keys that make an object a person's record by themselves. Address fields are not among them: a
 * shop's store list has a `city` too, and its `name` is public.
 */
const PERSON_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'username',
  'login',
  'displayname',
  'firstname',
  'lastname',
  'fullname',
  'email',
  'emailaddress',
])

/**
 * True when an object describes a person: it sits under a user/account/profile/customer name,
 * or it carries an identity field itself (`GET /api/me` answers `{ id, username, email }` at
 * the top level).
 */
export function isPersonObject(parentName: string | null | undefined, keys: readonly string[]): boolean {
  if (parentName !== null && parentName !== undefined && words(parentName).some(word => PERSON_OBJECT_WORDS.has(word)))
    return true
  return keys.some(key => PERSON_IDENTITY_KEYS.has(compactName(key)))
}

/** `name` and `id` of a person's record. */
export function isPersonRecordField(name: string | null | undefined): boolean {
  return name !== null && name !== undefined && PERSON_RECORD_FIELDS.has(compactName(name))
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
