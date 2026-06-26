import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const PREFIX = '__enc__'

/** Derive a 32-byte AES key from HIDOCK_SECRET_KEY, or null if unset. */
function getKey(): Buffer | null {
  const secret = process.env.HIDOCK_SECRET_KEY
  if (!secret) return null
  return scryptSync(secret, 'hidock-config-salt', 32)
}

/**
 * Encrypt a sensitive config value with AES-256-GCM, '__enc__'-prefixed.
 * No key configured ⇒ returns plaintext (mirrors safeStorage-unavailable).
 * Already-encrypted ⇒ returned as-is (never double-wrap).
 */
export function encryptSensitive(value: string): string {
  if (!value || value.startsWith(PREFIX)) return value
  const key = getKey()
  if (!key) return value
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64')
}

/** Inverse of encryptSensitive. Non-prefixed or undecryptable values pass through. */
export function decryptSensitive(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value
  const key = getKey()
  if (!key) return value
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const enc = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return value
  }
}
