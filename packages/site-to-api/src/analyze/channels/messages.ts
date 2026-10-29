/**
 * Groups the frames of one channel direction into message types and infers a schema for each.
 */
import type { ChannelMessage, JsonSchema, RedactContext, Redactor, WebSocketChannel } from '../../model'
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
/**
 * A field with more distinct values than this is data (an id, a timestamp), not a message type.
 * Real feeds have a few dozen event names (`evt0` ... `evt20` next to `tick`).
 */
const MAX_GROUPS = 32
/** Share of the messages the field must be on; the rest (acknowledgements, errors) form one group. */
const MIN_COVERAGE = 0.8
/** Samples per message type used for schema inference; enough to see every optional field. */
const MAX_SCHEMA_SAMPLES = 1000
/** Longer text frames get no example, like long text request bodies. */
const MAX_TEXT_EXAMPLE_LENGTH = 2000
const MAX_SHAPES = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The string at `path` (`type`, `data.e`), or undefined. */
function stringAt(value: unknown, path: readonly string[]): string | undefined {
  let current = value
  for (const key of path) {
    if (!isRecord(current))
      return undefined
    current = current[key]
  }
  return typeof current === 'string' && current !== ''
    ? current
    : undefined
}

/** Paths of string fields of one object, top level and one object down, without dotted keys. */
function stringPaths(object: Record<string, unknown>, depth: number): string[][] {
  return Object.entries(object).flatMap(([key, value]) => {
    if (key.includes('.'))
      return []
    if (typeof value === 'string') {
      return [
        [key],
      ]
    }
    return depth > 1 && isRecord(value)
      ? stringPaths(value, depth - 1).map(path => [key, ...path])
      : []
  })
}

/** Every path {@link stringPaths} finds in any of the messages, once each. */
function candidatePaths(objects: ReadonlyArray<Record<string, unknown>>): string[][] {
  const paths = new Map<string, string[]>()
  for (const object of objects) {
    for (const path of stringPaths(object, 2))
      paths.set(path.join('.'), path)
  }
  return [
    ...paths.values(),
  ]
}

/** How a direction's JSON messages are told apart. */
export interface DiscriminatorChoice {
  /** The field, as a dotted path (`type`, `data.e`); null when none groups the messages. */
  field: string | null
  /** When no field was chosen: the best one left out for having more than {@link MAX_GROUPS} values. */
  tooMany: { field: string, values: number } | null
}

interface Candidate {
  field: string
  present: number
  distinct: number
  rank: number
  depth: number
}

function byStrength(a: Candidate, b: Candidate): number {
  return b.present - a.present || a.rank - b.rank || a.depth - b.depth || a.distinct - b.distinct || a.field.localeCompare(b.field)
}

/**
 * The field that tells this direction's JSON messages apart (decision 0030).
 *
 * Candidates are string fields at the top level or one object down (`data.e`) that hold a
 * non-empty string in at least {@link MIN_COVERAGE} of the messages, with at most
 * {@link MAX_GROUPS} distinct values, each of which the redactor leaves unchanged (a value that
 * names a group is written into the output). A field with a well-known name (`type`, `event`,
 * `op`, ...) may have a single value; any other needs two or more, some repeating. The field
 * that groups the most messages wins; ties go to the well-known name order, then the shallower
 * field, then the fewer values.
 */
export function chooseDiscriminator(messages: readonly unknown[], isSafeValue: (field: string, value: string) => boolean): DiscriminatorChoice {
  const objects = messages.filter(isRecord)
  const accepted: Candidate[] = []
  const tooMany: Candidate[] = []
  for (const path of candidatePaths(objects)) {
    const values = objects.flatMap((object) => {
      const value = stringAt(object, path)
      return value === undefined
        ? []
        : [value]
    })
    if (values.length === 0 || values.length < MIN_COVERAGE * messages.length)
      continue
    const field = path.join('.')
    const last = path.at(-1) ?? field
    const distinct = new Set(values)
    const known = DISCRIMINATOR_NAMES.indexOf(last)
    const candidate = {
      field,
      present: values.length,
      distinct: distinct.size,
      rank: known === -1
        ? DISCRIMINATOR_NAMES.length
        : known,
      depth: path.length,
    }
    if (known === -1 && (distinct.size < 2 || distinct.size === values.length))
      continue
    if (![...distinct].every(value => isSafeValue(last, value)))
      continue
    if (distinct.size > MAX_GROUPS)
      tooMany.push(candidate)
    else
      accepted.push(candidate)
  }
  const best = accepted.sort(byStrength)[0]
  if (best)
    return { field: best.field, tooMany: null }
  const lost = tooMany.sort((a, b) => a.rank - b.rank || byStrength(a, b))[0]
  return {
    field: null,
    tooMany: lost
      ? { field: lost.field, values: lost.distinct }
      : null,
  }
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
function pinDiscriminator(schema: JsonSchema, path: readonly string[], value: string): JsonSchema {
  const [key, ...rest] = path
  if (key === undefined)
    return schema
  const property = schema.properties?.[key]
  if (!property)
    return schema
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [key]: rest.length === 0
        ? { type: 'string', const: value }
        : pinDiscriminator(property, rest, value),
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
  /** Set when this direction's JSON messages differ in shape but no field could group them. */
  ungrouped: WebSocketChannel['ungrouped'][number] | null
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
  const choice = chooseDiscriminator(json.map(item => item.frame.json), (name, value) => redactor.value(value, { ...context, name }) === value)
  const field = choice.field
  const path = field?.split('.') ?? []

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
    else if (field !== null && stringAt(frame.json, path) !== undefined) {
      const value = stringAt(frame.json, path) ?? ''
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
      schemaSamples: null,
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
      schemaSamples: samples.length,
      schema: group.discriminator
        ? pinDiscriminator(inferred, group.discriminator.field.split('.'), group.discriminator.value)
        : inferred,
      shapes: [],
      examples: redactor.examples(group.frames.map(item => item.frame.json), context),
    }
  })
  return {
    messages,
    messageOf,
    ungrouped: ungroupedOf(direction, json, choice),
  }
}

/**
 * A direction whose JSON messages come in several shapes (different top-level fields) but share
 * no field that names their type: they all end up in one message with a merged schema.
 */
function ungroupedOf(direction: ChannelMessage['direction'], json: readonly KeyedFrame[], choice: DiscriminatorChoice): GroupedMessages['ungrouped'] {
  if (choice.field !== null || json.length < 2)
    return null
  const shapes = new Set(json.map(item => isRecord(item.frame.json)
    ? Object.keys(item.frame.json).sort().join('\u0000')
    : 'array'))
  if (choice.tooMany === null && shapes.size < 2)
    return null
  return {
    direction,
    field: choice.tooMany?.field ?? null,
    values: choice.tooMany?.values ?? null,
  }
}
