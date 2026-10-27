/**
 * Fake secrets and personal data for redaction tests. None of these are real; they only have the
 * shapes real values have.
 */
import type { ResolvedConfig } from '../src/config/schema'
import type { Exchange } from '../src/model'
import { exchange, formBody, jsonBody, textBody } from './helpers'

function fakeJwt(payload: object): string {
  const encode = (value: object): string => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.c2lnbmF0dXJlLWZha2U`
}

export const SECRETS = {
  sessionCookie: 'sess_9f8e7d6c5b4a3f2e1d0c',
  akamaiCookie: 'ABCK0123456789abcdefXYZ~0~',
  setCookie: 'new-session-value-77aa88bb',
  bearer: 'opaque-token-1234567890',
  jwt: fakeJwt({ sub: 'user-42', exp: 1_900_000_000 }),
  csrf: 'csrf-5f4e3d2c1b0a',
  password: 'hunter2-Password!',
  formToken: 'form-token-556677',
  secondFormToken: 'form-token-second-889900',
  nestedToken: 'nested-access-token-abcdef',
  signature: 'signature-abcdef123',
  oauthCode: 'oauth-code-998877',
  device: 'device-fingerprint-0001',
  email: 'jane.doe@mail.test',
  phone: '+91 98765 43210',
  pan: 'ABCDE1234F',
  aadhaar: '2345 6789 0124',
  aadhaarNumber: 234567890124,
  card: '4111 1111 1111 1111',
  employeeId: 'EMP-123456',
  responseToken: 'response-refresh-token-xyz789',
} as const

export const CONFIG: ResolvedConfig['redact'] = {
  examples: 'masked',
  maxExamples: 3,
  patterns: [
    { name: 'employee', regex: 'EMP-\\d{6}' },
  ],
  fields: ['X-Device'],
}

/** Two sessions: secrets in every place a site can put them. */
export function fixtureExchanges(): Exchange[] {
  const s = SECRETS
  return [
    exchange({
      sessionId: 's1',
      method: 'POST',
      url: `https://shop.test/api/login?sig=${s.signature}&lang=en`,
      requestHeaders: {
        'authorization': `Bearer ${s.bearer}`,
        'x-csrf-token': s.csrf,
        'x-device': s.device,
        'x-client-version': '1.2.3',
        'referer': `https://shop.test/start?code=${s.oauthCode}`,
      },
      cookies: { session: s.sessionCookie, _abck: s.akamaiCookie, theme: 'dark' },
      requestBody: formBody({ user: s.email, password: s.password, token: s.formToken }),
      setCookies: { session: s.setCookie },
      responseBody: jsonBody({
        token: s.jwt,
        refreshToken: s.responseToken,
        user: {
          email: s.email,
          mobile: '9876543210',
          contact: s.phone,
          pan: s.pan,
          aadhaar: s.aadhaar,
          aadhaarNumber: s.aadhaarNumber,
          card: s.card,
          employee: `Employee ${s.employeeId}`,
          note: `your session is ${s.sessionCookie}`,
        },
        payload: JSON.stringify({
          accessToken: s.nestedToken,
          list: [s.email],
        }),
        redirect: `https://shop.test/cb?code=${s.oauthCode}&state=ok`,
        encoded: encodeURIComponent(`user=${s.email}`),
        bearerText: `Authorization: Bearer ${s.jwt}`,
      }),
    }),
    exchange({
      sessionId: 's2',
      url: 'https://shop.test/api/profile',
      requestHeaders: { 'authorization': `Bearer ${s.jwt}`, 'x-client-version': '1.2.3' },
      cookies: { session: s.setCookie },
      responseBody: jsonBody({ name: 'Jane', email: s.email, html: `<a href="mailto:${s.email}">mail</a>` }),
    }),
    exchange({
      sessionId: 's2',
      method: 'POST',
      url: 'https://shop.test/api/raw',
      requestBody: textBody(`token=${s.secondFormToken}&user=${encodeURIComponent(s.email)}`, 'text/plain'),
      responseBody: textBody(`ok ${s.jwt}`, 'text/plain'),
    }),
  ]
}
