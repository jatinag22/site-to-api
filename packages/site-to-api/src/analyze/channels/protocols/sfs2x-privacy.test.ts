import { describe, expect, it } from 'vitest'
import { maskSystemParams } from './sfs2x-privacy'

function params(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, entries)
}

describe('maskSystemParams', () => {
  it('masks user arrays at id and name, keeping the other slots', () => {
    const { params: masked, secrets } = maskSystemParams('JoinRoom', params({
      r: [3, 'lobby'],
      ul: [
        [1000, 'rival_anna', 0, 1, []],
        [123_456, 'Rival_Ben', 0, 2, []],
      ],
    }))
    expect(masked).toEqual({
      r: [3, 'lobby'],
      ul: [
        [0, 'xxxxx_xxxx', 0, 1, []],
        [0, 'Xxxxx_Xxx', 0, 2, []],
      ],
    })
    expect(secrets).toEqual(['rival_anna', '123456', 'Rival_Ben'])
  })

  it('masks senders, recipients and chat text of a message, without hunting the text elsewhere', () => {
    const { params: masked, secrets } = maskSystemParams('GenericMessage', params({
      t: 1,
      u: 1000,
      rc: 1001,
      m: 'meet at 9',
    }))
    expect(masked).toEqual({ t: 1, u: 0, rc: 0, m: 'xxxx xx 0' })
    expect(secrets).toEqual([])
  })

  it('masks users entering, user lists, buddies and buddy names', () => {
    expect(maskSystemParams('UserEnterRoom', params({
      u: [7, 'cleo', 0, 0, []],
      r: 3,
    })).params).toEqual({
      u: [0, 'xxxx', 0, 0, []],
      r: 3,
    })
    expect(maskSystemParams('UserExitRoom', params({ u: 7, r: 3 })).params).toEqual({ u: 0, r: 3 })
    expect(maskSystemParams('FindUsers', params({
      fu: [
        [7, 'dora', 0, 0, []],
      ],
    })).params).toEqual({
      fu: [
        [0, 'xxxx', 0, 0, []],
      ],
    })
    expect(maskSystemParams('SetUserPosition', params({
      p: [
        [7, 'eve', 0, 0, []],
      ],
      m: [8, 9],
    })).params).toEqual({
      p: [
        [0, 'xxx', 0, 0, []],
      ],
      m: [0, 0],
    })
    expect(maskSystemParams('InitBuddyList', params({
      bl: [
        [4, 'emil', false, []],
      ],
    })).params).toEqual({
      bl: [
        [0, 'xxxx', false, []],
      ],
    })
    expect(maskSystemParams('GoOnline', params({ bn: 'emil', bi: 4, o: 0 })).params).toEqual({ bn: 'xxxx', bi: 0, o: 0 })
    expect(maskSystemParams('AddBuddy', params({
      bn: [4, 'emil', false, []],
    })).params).toEqual({
      bn: [0, 'xxxx', false, []],
    })
  })

  it('masks string values of user and buddy variables, keeping names, types and other values', () => {
    const userVars = [
      ['nick', 8, 'VarNickZed'],
      ['level', 4, 12],
      ['vip', 1, true],
    ]
    const masked = maskSystemParams('UserEnterRoom', params({
      u: [7, 'cleo', 0, 0, userVars],
      r: 3,
    }))
    expect(masked.params).toEqual({
      u: [
        0,
        'xxxx',
        0,
        0,
        [
          ['nick', 8, 'XxxXxxxXxx'],
          ['level', 4, 12],
          ['vip', 1, true],
        ],
      ],
      r: 3,
    })
    expect(masked.secrets).toEqual(['cleo', 'VarNickZed'])
    const set = maskSystemParams('SetUserVariables', params({
      u: 7,
      vl: [
        ['realName', 8, 'Quill Ferro'],
        ['mood', 8, 'ok'],
      ],
    }))
    expect(set.params).toEqual({
      u: 0,
      vl: [
        ['realName', 8, 'Xxxxx Xxxxx'],
        ['mood', 8, 'xx'],
      ],
    })
    // `ok` is masked where it sits but too short to hunt elsewhere.
    expect(set.secrets).toEqual(['Quill Ferro'])
    expect(maskSystemParams('InitBuddyList', params({
      bl: [
        [
          4,
          'emil',
          false,
          [
            ['$room', 8, 'Den of Wolves'],
          ],
        ],
      ],
      mv: [
        ['$mood', 8, 'sleepy'],
      ],
    })).params).toEqual({
      bl: [
        [
          0,
          'xxxx',
          false,
          [
            ['$room', 8, 'Xxx xx Xxxxxx'],
          ],
        ],
      ],
      mv: [
        ['$mood', 8, 'xxxxxx'],
      ],
    })
    expect(maskSystemParams('AddBuddy', params({
      bn: [
        4,
        'emil',
        false,
        [
          ['city', 8, 'Velmora'],
        ],
      ],
    })).params).toEqual({
      bn: [
        0,
        'xxxx',
        false,
        [
          ['city', 8, 'Xxxxxxx'],
        ],
      ],
    })
    expect(maskSystemParams('SetBuddyVariables', params({
      bn: 'emil',
      bv: [
        ['$status', 8, 'away-long'],
      ],
    })).params).toEqual({
      bn: 'xxxx',
      bv: [
        ['$status', 8, 'xxxx-xxxx'],
      ],
    })
    expect(maskSystemParams('JoinRoom', params({
      ul: [
        [
          1,
          'ana',
          0,
          1,
          [
            ['nick', 8, 'Zed'],
          ],
        ],
      ],
    })).params).toEqual({
      ul: [
        [
          0,
          'xxx',
          0,
          1,
          [
            ['nick', 8, 'Xxx'],
          ],
        ],
      ],
    })
  })

  it('treats every string of the login\'s custom params as a credential', () => {
    const { params: masked, secrets } = maskSystemParams('Login', params({
      zn: 'zone',
      un: 'gambler7',
      p: params({
        k: 'kq9-launch-key',
        ticket: 't1',
        nested: params({ sig: 'abcdefgh' }),
        list: ['x1y2z3w4'],
        n: 5,
        empty: '',
      }),
    }))
    // Long ones stay for value tracing and go to the redactor as secrets; short ones (`t1`) are
    // replaced where they sit, not hunted elsewhere.
    expect(masked).toMatchObject({
      zn: 'zone',
      un: 'xxxxxxx0',
      p: {
        k: 'kq9-launch-key',
        ticket: expect.stringMatching(/^<redacted/) as unknown,
        n: 5,
        empty: '',
      },
    })
    expect(secrets).toEqual([
      'gambler7',
      'kq9-launch-key',
      'abcdefgh',
      'x1y2z3w4',
    ])
  })

  it('leaves actions without people and unknown params alone', () => {
    const input = params({ u: 5, other: 'x' })
    expect(maskSystemParams('PingPong', input)).toEqual({
      params: { u: 5, other: 'x' },
      secrets: [],
    })
  })
})
