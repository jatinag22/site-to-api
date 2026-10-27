/** Login form: CSRF token from the page, encrypted password, bearer token kept for the tab. */
import { z } from 'zod'
import { ApiError, getJson, postJson } from '../api/client'
import { encryptPassword } from './crypto'
import { saveAccessToken } from './session'

const LoginKeySchema = z.object({
  keyId: z.string(),
  algorithm: z.string(),
  publicKey: z.string(),
})
const LoginResponseSchema = z.object({
  token: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number(),
  user: z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    email: z.string(),
  }),
})

/** Reads the CSRF token the server rendered into `<meta name="csrf-token">`. */
function readCsrfToken(): string {
  const token = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content
  if (token === undefined || token === '')
    throw new Error('the login page has no csrf-token meta tag')
  return token
}

async function fetchLoginKey(): Promise<z.infer<typeof LoginKeySchema>> {
  return getJson('/api/auth/key', LoginKeySchema)
}

/** Signs in with the form's values and returns the bearer token. */
async function submitLogin(username: string, password: string): Promise<string> {
  const key = await fetchLoginKey()
  const encryptedPassword = await encryptPassword(password, key.publicKey)
  const result = await postJson(
    '/api/auth/login',
    { username, password: encryptedPassword },
    LoginResponseSchema,
    {
      'x-csrf-token': readCsrfToken(),
    },
  )
  saveAccessToken(result.token)
  return result.token
}

/** Wires the login form: submit → encrypted login → account page. */
export function bindLoginForm(form: HTMLFormElement): void {
  const error = document.querySelector('#login-error')
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = new FormData(form)
    submitLogin(String(data.get('username') ?? ''), String(data.get('password') ?? ''))
      .then(() => location.assign('/account'))
      .catch((failure: unknown) => {
        if (error !== null) {
          error.textContent = failure instanceof ApiError && failure.status === 401
            ? 'Wrong username or password.'
            : 'Sign-in failed, please try again.'
        }
      })
  })
}
