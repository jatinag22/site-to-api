import { describe, expect, it } from 'vitest'
import { closestKey, envName, sourceOf, syntaxExcerpt } from './errors'

const layers = {
  file: '/project/site-to-api.config.ts',
  fromFile: {
    probe: { maxRps: 2 },
  },
  fromEnv: {
    probe: { timeoutMs: 'x' },
  },
  fromFlags: { rawDir: 5 },
  env: { SITE_TO_API_PROBE__TIMEOUT_MS: 'x' },
}

describe('config errors', () => {
  it('names the layer a value came from, highest precedence first', () => {
    expect(sourceOf(['rawDir'], layers)).toBe('CLI flag --raw-dir')
    expect(sourceOf(['probe', 'timeoutMs'], layers)).toBe('environment variable SITE_TO_API_PROBE__TIMEOUT_MS')
    expect(sourceOf(['probe', 'maxRps'], layers)).toBe('config file /project/site-to-api.config.ts')
  })

  it('suggests a close known key and nothing for a far one', () => {
    expect(closestKey(['capture', 'browser'], 'headles')).toBe('headless')
    expect(closestKey(['capture', 'browser'], 'user_data_dir')).toBe('userDataDir')
    expect(closestKey([], 'zzzzzz')).toBeNull()
    expect(envName(['capture', 'browser', 'userDataDir'])).toBe('SITE_TO_API_CAPTURE__BROWSER__USER_DATA_DIR')
  })

  it('shows no excerpt for a message without a location', () => {
    expect(syntaxExcerpt('{}', 'something else went wrong')).toBe('')
    expect(syntaxExcerpt('{}', 'Unexpected token (line 9 column 1)')).toBe('')
  })
})
