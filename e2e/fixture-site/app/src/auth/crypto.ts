/** Password encryption done in the browser before the login request is sent. */

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Encrypts `password` with the server's RSA public key (SPKI, base64) using RSA-OAEP with
 * SHA-256 and returns the ciphertext as base64. The server decrypts it with its private key.
 */
export async function encryptPassword(password: string, publicKeySpki: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(publicKeySpki),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  )
  const ciphertext = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(password))
  return bytesToBase64(new Uint8Array(ciphertext))
}
