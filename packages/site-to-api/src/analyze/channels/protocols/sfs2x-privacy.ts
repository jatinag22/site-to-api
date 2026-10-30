/**
 * What SFS2X system messages carry about people, masked before it becomes a payload (decision
 * 0048). SFS2X sends users as positional arrays (`[id, name, privilegeId, playerId, variables]`),
 * buddies as `[id, name, blocked, variables]`, and chat as `m`; no field name says "user name",
 * so the redactor's name rules cannot see them. The slots come from the published client API's
 * handlers. The login's custom params are credentials whatever their names.
 */
import { maskKeepingFormat, placeholder } from '../../redact'

/** Values the redactor should also scrub wherever else they appear. */
export interface Masked {
  params: Record<string, unknown>
  secrets: string[]
}

/**
 * A numeric value shorter than this is not scrubbed everywhere: every `1000` in the output would
 * go with a user id of 1000. It is still masked where the protocol puts it.
 */
const MIN_GLOBAL_NUMBER_DIGITS = 6
/** Shorter strings (`en`, `USD`) are masked where they sit but not hunted elsewhere. */
const MIN_GLOBAL_STRING_LENGTH = 6

type Slot = 'id' | 'name' | 'user' | 'users' | 'ids' | 'text' | 'buddies'

/** Params of each system action that hold people, and how. */
const SLOTS: ReadonlyMap<string, Readonly<Record<string, Slot>>> = new Map<string, Readonly<Record<string, Slot>>>([
  [
    'JoinRoom',
    { ul: 'users' },
  ],
  [
    'UserEnterRoom',
    { u: 'user' },
  ],
  [
    'UserExitRoom',
    { u: 'user' },
  ],
  [
    'UserLost',
    { u: 'user' },
  ],
  [
    'SetUserVariables',
    { u: 'user' },
  ],
  [
    'SpectatorToPlayer',
    { u: 'user' },
  ],
  [
    'PlayerToSpectator',
    { u: 'user' },
  ],
  [
    'KickUser',
    { u: 'user' },
  ],
  [
    'BanUser',
    { u: 'user' },
  ],
  // Public, private, buddy, moderator and admin messages: sender, recipient, text, sender data.
  [
    'GenericMessage',
    {
      u: 'user',
      rc: 'user',
      m: 'text',
      sd: 'user',
    },
  ],
  [
    'FindUsers',
    { fu: 'users' },
  ],
  // MMO area of interest: users entering (`p`) and leaving (`m`, ids).
  [
    'SetUserPosition',
    { p: 'users', m: 'ids' },
  ],
  [
    'InitBuddyList',
    { bl: 'buddies' },
  ],
  [
    'AddBuddy',
    { bn: 'user' },
  ],
  [
    'BlockBuddy',
    { bn: 'name', bd: 'user' },
  ],
  [
    'RemoveBuddy',
    { bn: 'name' },
  ],
  [
    'SetBuddyVariables',
    { bn: 'name' },
  ],
  [
    'GoOnline',
    { bn: 'name', bi: 'id' },
  ],
  [
    'InviteUsers',
    {
      u: 'user',
      ui: 'id',
      iu: 'ids',
      ee: 'id',
    },
  ],
  [
    'InvitationReply',
    { u: 'user', ui: 'id', ee: 'id' },
  ],
  [
    'Login',
    { un: 'name', id: 'id' },
  ],
])

class Collector {
  readonly secrets: string[] = []

  /** A user name, chat text or id string, masked keeping its format. */
  text(value: string, global: boolean): string {
    if (global && value.length > 0)
      this.secrets.push(value)
    return maskKeepingFormat(value)
  }

  /** An id: a number becomes 0 (still an integer in the schema), a string keeps its format. */
  id(value: unknown): unknown {
    if (typeof value === 'number') {
      if (String(value).length >= MIN_GLOBAL_NUMBER_DIGITS)
        this.secrets.push(String(value))
      return 0
    }
    return typeof value === 'string'
      ? this.text(value, value.length >= MIN_GLOBAL_STRING_LENGTH)
      : value
  }

  /** `[id, name, ...]` (a user or a buddy), or a bare id. */
  user(value: unknown): unknown {
    if (!Array.isArray(value))
      return this.id(value)
    return value.map((item: unknown, index) => {
      if (index === 0)
        return this.id(item)
      if (index === 1 && typeof item === 'string')
        return this.text(item, true)
      return item
    })
  }

  slot(slot: Slot, value: unknown): unknown {
    switch (slot) {
      case 'id':
        return this.id(value)
      case 'name':
        return typeof value === 'string'
          ? this.text(value, true)
          : this.user(value)
      case 'text':
        return typeof value === 'string'
          ? this.text(value, false)
          : value
      case 'user':
        return this.user(value)
      case 'ids':
        return Array.isArray(value)
          ? value.map((item: unknown) => this.id(item))
          : this.id(value)
      case 'users':
      case 'buddies':
        return Array.isArray(value)
          ? value.map((item: unknown) => this.user(item))
          : value
    }
  }

  /**
   * Every string under the login's custom params: credentials whatever their names. A long one
   * stays in the payload as a secret for the redactor, which hides it everywhere and still lets
   * value tracing find where it came from (a launch URL); a short one (`en`, `t1`) is replaced
   * here, since hunting it everywhere would hide every `en` in the output.
   */
  credentials(value: unknown, depth: number): unknown {
    if (typeof value === 'string') {
      if (value.length >= MIN_GLOBAL_STRING_LENGTH) {
        this.secrets.push(value)
        return value
      }
      return value === ''
        ? value
        : placeholder(value)
    }
    if (depth > 32)
      return null
    if (Array.isArray(value))
      return value.map((item: unknown) => this.credentials(item, depth + 1))
    if (value !== null && typeof value === 'object') {
      return copy(Object.entries(value).map(([key, item]) => [
        key,
        this.credentials(item, depth + 1),
      ]))
    }
    return value
  }
}

function copy(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  const object = Object.create(null) as Record<string, unknown>
  for (const [key, value] of entries)
    object[key] = value
  return object
}

/**
 * The params of a system action with the people in them masked: user and buddy ids (to 0) and
 * names, chat text, and every string of the login's custom params `p`. Names, long ids and long
 * login strings are also returned as secrets for the redactor.
 */
export function maskSystemParams(action: string, params: Record<string, unknown>): Masked {
  const collector = new Collector()
  const slots = SLOTS.get(action) ?? {}
  const masked = copy(Object.entries(params).map(([key, value]) => {
    const slot = Object.hasOwn(slots, key)
      ? slots[key]
      : undefined
    if (action === 'Login' && key === 'p') {
      return [
        key,
        collector.credentials(value, 0),
      ]
    }
    return [
      key,
      slot === undefined
        ? value
        : collector.slot(slot, value),
    ]
  }))
  return { params: masked, secrets: collector.secrets }
}
