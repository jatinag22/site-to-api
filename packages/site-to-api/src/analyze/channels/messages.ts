/**
 * Groups the frames of one channel direction into message types and infers a schema for each.
 */
import type { ChannelMessage, JsonSchema, RedactContext, Redactor } from '../../model'
import type { Frame } from './connections'
import { camelCase } from '../operations'
import { inferSchema } from '../schema'
import { describeShape } from '../shape'

/** A frame with the session it was captured in and a key unique per build. */
export interface KeyedFrame {
  /** `<connection id>:<frame index>`. */
  key: string
  sessionId: string
  frame: Frame
}

/**
 * Field names sites use to say what a message is, in order of preference. One of them wins over
 * any other shared string field, even when it has a single value.
 */
const DISCRIMINATOR_NAMES: readonly string[] = [
  'type',
  'event',
  'op',
  'action',
  'method',
  'kind',
  'cmd',
  'command',
  't',
  'e',
  'name',
  'topic',
]
/** A field with more distinct values than this is data (an id, a timestamp), not a message type. */
const MAX_GROUPS = 16
/** Samples per message type used for schema inference; enough to see every optional field. */
const MAX_SCHEMA_SAMPLES = 1000
/** Longer text frames get no example, like long text request bodies. */
const MAX_TEXT_EXAMPLE_LENGTH = 2000
const MAX_SHAPES = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The top-level field that tells this direction's JSON messages apart, or null.
 *
 * Candidates are fields that hold a non-empty string in every message (so every message falls
 * into exactly one group) with at most {@link MAX_GROUPS} distinct values, each of which the
 * redactor leaves unchanged (a value that names a group is written into the output). A well-known
 * name (`type`, `event`, `op`, `action`, ...) wins in that order; otherwise the field with the
 * fewest distinct values, provided it has two or more and some value repeats. Any message that is
 * not a JSON object means no discriminator.
 */
export function chooseDiscriminator(messages: readonly unknown[], isSafeValue: (field: string, value: string) => boolean): string | null {
  const objects = messages.filter(isRecord)
  if (objects.length === 0 || objects.length !== messages.length)
    return null
  const candidates: Array<{ field: string, distinct: number, rank: number }> = []
  for (const field of Object.keys(objects[0]!)) {
    const values = objects.map(object => object[field]).filter((value): value is string => typeof value === 'string' && value !== '')
    if (values.length !== objects.length)
      continue
    const distinct = new Set(values)
    if (distinct.size > MAX_GROUPS || ![...distinct].every(value => isSafeValue(field, value)))
      continue
    const rank = DISCRIMINATOR_NAMES.indexOf(field)
    if (rank === -1 && (distinct.size < 2 || distinct.size === objects.length))
      continue
    candidates.push({
      field,
      distinct: distinct.size,
      rank: rank === -1
        ? DISCRIMINATOR_NAMES.length
        : rank,
    })
  }
  candidates.sort((a, b) => a.rank - b.rank || a.distinct - b.distinct || a.field.localeCompare(b.field))
  return candidates[0]?.field ?? null
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** `send` + `price-update` → `sendPriceUpdate`; values without letters or digits fall back. */
function messageId(direction: ChannelMessage['direction'], name: string, fallback: string): string {
  const part = capitalize(camelCase(name))
  return `${direction}${part === ''
    ? fallback
    : part}`
}

/** Pins the discriminator in the schema, so the message type is part of the contract. */
function pinDiscriminator(schema: JsonSchema, field: string, value: string): JsonSchema {
  if (!schema.properties?.[field])
    return schema
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [field]: { type: 'string', const: value },
    },
  }
}

function enumGuard(redactor: Redactor, context: RedactContext): { allowEnumValue: (value: string) => boolean } {
  return {
    allowEnumValue: value => redactor.value(value, context) === value,
  }
}

function mostCommon(values: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>()
  for (const value of values)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value)
}

/** Message types of one direction, and which type each frame belongs to. */
export interface GroupedMessages {
  messages: ChannelMessage[]
  /** Message id per {@link KeyedFrame.key}. */
  messageOf: Map<string, string>
}

interface Group {
  id: string
  discriminator: ChannelMessage['discriminator']
  format: ChannelMessage['format']
  frames: KeyedFrame[]
}

/**
 * Groups one direction's frames: JSON messages by their discriminator value (one group without
 * one), all non-JSON text frames together, all binary frames together. Groups keep the order in
 * which their first frame was captured. Examples and enum values go through the redactor; binary
 * frames are only counted.
 *
 * @param direction which side sent the frames
 * @param frames the frames of that direction, in capture order
 * @param redactor applied to examples, enum values and discriminator values
 * @param usedIds message ids already taken in this channel; new ids are added to it
 */
export function groupMessages(direction: ChannelMessage['direction'], frames: readonly KeyedFrame[], redactor: Redactor, usedIds: Set<string>): GroupedMessages {
  const context: RedactContext = {
    in: direction === 'send'
      ? 'body'
      : 'response-body',
  }
  const json = frames.filter(item => item.frame.json !== undefined)
  const field = chooseDiscriminator(json.map(item => item.frame.json), (name, value) => redactor.value(value, { ...context, name }) === value)

  const groups = new Map<string, Group>()
  const unique = (id: string): string => {
    let candidate = id
    for (let suffix = 2; usedIds.has(candidate); suffix++)
      candidate = `${id}${suffix}`
    usedIds.add(candidate)
    return candidate
  }
  for (const item of frames) {
    const { frame } = item
    let key: string
    let init: Omit<Group, 'frames'>
    if (frame.binary) {
      key = 'binary'
      init = { id: `${direction}Binary`, discriminator: null, format: 'binary' }
    }
    else if (frame.json === undefined) {
      key = 'text'
      init = { id: `${direction}Text`, discriminator: null, format: 'text' }
    }
    else if (field !== null && isRecord(frame.json) && typeof frame.json[field] === 'string') {
      const value = frame.json[field]
      key = `json:${value}`
      init = {
        id: messageId(direction, value, 'Message'),
        discriminator: { field, value },
        format: 'json',
      }
    }
    else {
      key = 'json'
      init = { id: `${direction}Message`, discriminator: null, format: 'json' }
    }
    let group = groups.get(key)
    if (!group) {
      group = {
        ...init,
        id: unique(init.id),
        frames: [],
      }
      groups.set(key, group)
    }
    group.frames.push(item)
  }

  const messageOf = new Map<string, string>()
  const messages = [
    ...groups.values(),
  ].map((group): ChannelMessage => {
    for (const item of group.frames)
      messageOf.set(item.key, group.id)
    const base = {
      id: group.id,
      direction,
      discriminator: group.discriminator,
      format: group.format,
      count: group.frames.length,
      links: [],
    }
    if (group.format === 'binary') {
      return {
        ...base,
        schema: null,
        shapes: [],
        examples: [],
      }
    }
    if (group.format === 'text') {
      const texts = group.frames.map(item => item.frame.data)
      return {
        ...base,
        schema: null,
        shapes: mostCommon(texts.map(describeShape), MAX_SHAPES),
        examples: redactor.examples(texts.filter(text => text.length <= MAX_TEXT_EXAMPLE_LENGTH), context),
      }
    }
    const samples = group.frames.slice(0, MAX_SCHEMA_SAMPLES).map(item => ({ value: item.frame.json, sessionId: item.sessionId }))
    const inferred = inferSchema(samples, enumGuard(redactor, context))
    return {
      ...base,
      schema: group.discriminator
        ? pinDiscriminator(inferred, group.discriminator.field, group.discriminator.value)
        : inferred,
      shapes: [],
      examples: redactor.examples(group.frames.map(item => item.frame.json), context),
    }
  })
  return { messages, messageOf }
}
