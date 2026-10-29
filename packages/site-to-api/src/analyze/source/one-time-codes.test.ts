import { afterAll, describe, expect, it } from 'vitest'
import { removeSessions, writeSession } from '../../../test/sessions'
import { findOneTimeCodes } from './index'

afterAll(removeSessions)

/** Shaped like Spotify's web player: an OTP library's defaults, the site's config, then the call. */
const PLAYER = [
  'class T{constructor({algorithm:e="SHA1",digits:s=6,period:o=30}={}){this.digits=s}}',
  'const lib={algorithm:"SHA1",digits:6};',
  'const eB=new T({period:30,algorithm:"SHA1",digits:6,secret:ej.secret});',
  'function eV(e,t){let i=eB.generate({timestamp:Date.now()});return{reason:e,productType:t,totp:i,totpServer:i}}',
].join('\n')

describe('findOneTimeCodes', () => {
  it('finds the property that holds a TOTP code in a file that configures the generator', async () => {
    const session = await writeSession('s1', [
      { url: 'https://cdn.music.test/web-player.js', file: 'scripts/web-player.js', content: PLAYER },
    ])
    const found = await findOneTimeCodes([session], new Set(['totp', 'reason', 'other']))
    expect(found.get('totp')).toEqual({
      field: 'totp',
      ref: {
        file: '/web-player.js',
        line: 4,
        column: 90,
        functionName: 'eV',
        original: false,
        excerpt: null,
      },
      config: { digits: 6, period: 30, algorithm: 'SHA1' },
    })
    // Every requested field in such a file is reported; the build asks only about fields that
    // sent an untraced 6 to 8 digit value, and a field nobody wrote is never found.
    expect(found.has('reason')).toBe(true)
    expect(found.has('other')).toBe(false)
  })

  it('reports nothing for a file without an OTP generator config', async () => {
    const session = await writeSession('s1', [
      { url: 'https://cdn.music.test/app.js', file: 'scripts/app.js', content: 'const digits=6;function f(i){return{totp:i,digits:{count:6}}}' },
    ])
    expect((await findOneTimeCodes([session], new Set(['totp']))).size).toBe(0)
  })
})
