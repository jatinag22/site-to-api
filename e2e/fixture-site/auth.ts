/**
 * Login for the fixture site: CSRF tokens, an RSA key the browser encrypts the password with,
 * sessions and JWT-shaped bearer tokens. The credentials are fake test values documented in
 * `e2e/README.md`; nothing here protects real data.
 */
import { Buffer } from 'node:buffer'
import { constants, createHmac, generateKeyPairSync, privateDecrypt, timingSafeEqual } from 'node:crypto'
import { createRng } from './random'

/** The only account. Public on purpose: the e2e scenarios type these into the login form. */
const DEMO_USER = {
  username: 'demo',
  password: 'demo-password',
  id: 'usr_demo_0001',
  displayName: 'Demo Shopper',
  email: 'demo@pinewood.example',
} as const

export interface User {
  id: string
  username: string
  displayName: string
  email: string
}

type LoginResult
  = | { ok: true, token: string, sessionId: string, user: User }
    | { ok: false, status: 400 | 401, error: string }

export interface AuthService {
  /** Identifier of the current RSA key, echoed by `GET /api/auth/key`. */
  keyId: string
  /** RSA public key, SubjectPublicKeyInfo DER, base64. */
  publicKeySpki: string
  issueCsrfToken: () => string
  verifyCsrfToken: (token: string | undefined) => boolean
  /** Checks a username and an RSA-OAEP (SHA-256) encrypted, base64 password. */
  login: (username: string, encryptedPassword: string) => LoginResult
  /** Returns the user when the session cookie and the bearer token belong to the same session. */
  authenticate: (sessionCookie: string | undefined, authorization: string | undefined) => User | null
}

const TOKEN_LIFETIME_SECONDS = 3600

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Creates the auth service. The RSA key pair is generated per start (Node cannot derive RSA keys
 * from a seed); every other value comes from `seed`, so the same request sequence yields the same
 * CSRF tokens and session ids.
 */
export function createAuth(options: { seed: number, now: () => number }): AuthService {
  const rng = createRng(options.seed ^ 0x5EED)
  const secret = rng.hex(32)
  const keyId = `pm-key-${rng.hex(4)}`
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKeySpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const sessions = new Map<string, User>()

  function sign(data: string): string {
    return createHmac('sha256', secret).update(data).digest('base64url')
  }

  function issueCsrfToken(): string {
    const nonce = rng.hex(12)
    return `${nonce}.${sign(`csrf:${nonce}`)}`
  }

  function verifyCsrfToken(token: string | undefined): boolean {
    const [nonce, signature] = (token ?? '').split('.')
    return nonce !== undefined && signature !== undefined && safeEqual(signature, sign(`csrf:${nonce}`))
  }

  function issueJwt(user: User, sessionId: string): string {
    const issuedAt = Math.floor(options.now() / 1000)
    const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payload = base64Url(JSON.stringify({
      sub: user.id,
      name: user.displayName,
      sid: sessionId,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    }))
    return `${header}.${payload}.${sign(`${header}.${payload}`)}`
  }

  /** Returns the session id inside a valid, unexpired token. */
  function verifyJwt(token: string): string | null {
    const [header, payload, signature] = token.split('.')
    if (header === undefined || payload === undefined || signature === undefined)
      return null
    if (!safeEqual(signature, sign(`${header}.${payload}`)))
      return null
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof claims !== 'object' || claims === null || !('sid' in claims) || !('exp' in claims))
      return null
    const { sid, exp } = claims
    if (typeof sid !== 'string' || typeof exp !== 'number' || exp * 1000 < options.now())
      return null
    return sid
  }

  function decryptPassword(encrypted: string): string | null {
    try {
      return privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(encrypted, 'base64'),
      ).toString('utf8')
    }
    catch {
      // Expected for plain-text or corrupted passwords: the caller answers 400.
      return null
    }
  }

  function login(username: string, encryptedPassword: string): LoginResult {
    const password = decryptPassword(encryptedPassword)
    if (password === null)
      return { ok: false, status: 400, error: 'password must be RSA-OAEP encrypted with the key from /api/auth/key' }
    if (username !== DEMO_USER.username || !safeEqual(password, DEMO_USER.password))
      return { ok: false, status: 401, error: 'wrong username or password' }
    const user: User = {
      id: DEMO_USER.id,
      username: DEMO_USER.username,
      displayName: DEMO_USER.displayName,
      email: DEMO_USER.email,
    }
    const sessionId = rng.hex(16)
    sessions.set(sessionId, user)
    return {
      ok: true,
      token: issueJwt(user, sessionId),
      sessionId,
      user,
    }
  }

  function authenticate(sessionCookie: string | undefined, authorization: string | undefined): User | null {
    if (sessionCookie === undefined || authorization === undefined || !authorization.startsWith('Bearer '))
      return null
    const sid = verifyJwt(authorization.slice('Bearer '.length))
    if (sid === null || sid !== sessionCookie)
      return null
    return sessions.get(sid) ?? null
  }

  return {
    keyId,
    publicKeySpki,
    issueCsrfToken,
    verifyCsrfToken,
    login,
    authenticate,
  }
}
