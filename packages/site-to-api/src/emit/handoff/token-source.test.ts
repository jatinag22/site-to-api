import type { Analysis, FlowStep, Operation, SessionRequirement, ValueOrigin } from '../../model'
import type { AgentGuideContext } from './context'
import { describe, expect, it } from 'vitest'
import { shortVerdict } from './session'
import { tokenSources } from './token-source'

const API = 'api-partner.music.test'
const OPEN = 'open.music.test'

function operation(operationId: string, host: string, path: string): Operation {
  return {
    operationId,
    host,
    method: 'GET',
    path,
    kind: 'api',
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    requestBody: null,
    responses: [],
    sentFrom: [],
    sourceOnly: false,
    summary: '',
    exchanges: [],
  }
}

function step(id: string, operationId: string, inputs: Record<string, ValueOrigin>): FlowStep {
  return {
    id,
    operationId,
    kind: 'api',
    browserOnly: false,
    summary: '',
    sentFrom: null,
    inputs,
    outputs: {},
    observedIn: [],
  }
}

const tokenEntry: SessionRequirement = {
  host: API,
  requires: 'token',
  cookies: [],
  botProtection: [],
  probed: false,
}

/** A page that fetches a token (anonymously, or with a typed password) and then queries the API. */
function analysis(tokenInputs: Record<string, ValueOrigin>): Analysis {
  return {
    sessions: ['a'],
    hosts: [API, OPEN],
    operations: [
      operation('getApiToken', OPEN, '/api/token'),
      operation('queryArtist', API, '/pathfinder/v2/query'),
    ],
    flows: {
      formatVersion: 1,
      generatedBy: 'test',
      sessions: ['a'],
      session: [tokenEntry],
      flows: [
        {
          id: 'open',
          name: 'Open',
          trigger: { kind: 'navigate', label: 'Open', pageUrl: `https://${OPEN}/` },
          steps: [
            step('s1', 'getApiToken', tokenInputs),
          ],
          seenInSessions: 1,
        },
        {
          id: 'artist',
          name: 'Artist',
          trigger: { kind: 'navigate', label: 'Artist', pageUrl: `https://${OPEN}/artist` },
          steps: [
            step('s1', 'queryArtist', {
              'header.authorization': {
                kind: 'step',
                step: 'open.s1',
                output: 'body./accessToken',
                transform: 'substring',
              },
            }),
          ],
          seenInSessions: 1,
        },
      ],
      computedValues: [],
    },
    botProtection: [],
    excerpts: new Map(),
    warnings: [],
  }
}

const context: AgentGuideContext = {
  toolVersion: 'test',
  examples: 'masked',
  client: 'none',
  probed: false,
  probe: null,
}

describe('tokenSources', () => {
  it('names the anonymous token endpoint behind a host\'s Authorization header', () => {
    const anonymous = analysis({
      'query.reason': { kind: 'constant', value: 'init' },
    })
    expect(tokenSources(anonymous).get(API)).toEqual({ operationId: 'getApiToken', anonymous: true })
    const verdict = shortVerdict(tokenEntry, anonymous, context)
    expect(verdict).toBe('plain HTTP with an anonymous token from `getApiToken` (not yet probed)')
    expect(verdict).not.toContain('login')
  })

  it('calls a token step fed by a typed field a login step', () => {
    const login = analysis({
      'query.password': { kind: 'user-input', field: 'password' },
    })
    expect(tokenSources(login).get(API)).toEqual({ operationId: 'getApiToken', anonymous: false })
    expect(shortVerdict(tokenEntry, login, context)).toBe('plain HTTP with a bearer token from the login step `getApiToken` (not yet probed)')
  })

  it('keeps the general verdict when no traced step hands out the token', () => {
    const untraced = analysis({})
    untraced.flows.flows = untraced.flows.flows.slice(0, 1)
    expect(tokenSources(untraced).size).toBe(0)
    expect(shortVerdict(tokenEntry, untraced, context)).toBe('plain HTTP with a bearer token from a login step (not yet probed)')
  })
})
