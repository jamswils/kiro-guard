/**
 * passphrase.ts — app passphrase and recovery-answer verifiers.
 *
 * Alternative to the Windows credential prompt: no OS dialog to fight for
 * z-order, works offline, nothing to deadlock. Storage holds PBKDF2-SHA256
 * verifiers only (random 32-byte salt, 300k iterations); the secret itself is
 * never written. Comparison is constant-time.
 *
 * Recovery answers are names typed under mild stress, so case and whitespace
 * are ignored — normalised the SAME way before hashing and before checking, or
 * the stored hash can never match.
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto'
import type { RecoveryVerifier, SecretVerifier } from '../shared/types'

export const PBKDF2_ITERATIONS = 300_000
export const MIN_PASSPHRASE_LENGTH = 6
const KEY_LENGTH = 32
const DIGEST = 'sha256'

export function makeVerifier(secret: string, iterations: number = PBKDF2_ITERATIONS): SecretVerifier {
  const salt = randomBytes(32)
  const hash = pbkdf2Sync(secret, salt, iterations, KEY_LENGTH, DIGEST)
  return { salt: salt.toString('base64'), hash: hash.toString('base64'), iterations }
}

export function verifySecret(secret: string, v: SecretVerifier | undefined): boolean {
  if (!v || typeof v.salt !== 'string' || typeof v.hash !== 'string' || !Number.isFinite(v.iterations)) return false
  if (v.iterations < 1_000) return false   // refuse verifiers weakened on disk
  let expected: Buffer
  try { expected = Buffer.from(v.hash, 'base64') } catch { return false }
  if (expected.length !== KEY_LENGTH) return false
  const got = pbkdf2Sync(secret, Buffer.from(v.salt, 'base64'), v.iterations, KEY_LENGTH, DIGEST)
  return timingSafeEqual(got, expected)
}

/** Case- and whitespace-insensitive: "Van Der Berg" and "vanderberg" are the same answer. */
export function normaliseAnswer(answer: string): string {
  return (answer ?? '').trim().toLowerCase().replace(/\s+/g, '')
}

export function makeRecovery(question: string, answer: string, iterations: number = PBKDF2_ITERATIONS): RecoveryVerifier {
  return { question: question.trim(), ...makeVerifier(normaliseAnswer(answer), iterations) }
}

export function verifyRecovery(answer: string, r: RecoveryVerifier | undefined): boolean {
  if (!r) return false
  return verifySecret(normaliseAnswer(answer), r)
}

/** Validation shared by the settings window and the main-process save handler. */
export function validatePassphraseSetup(input: { passphrase: string; confirm: string; question: string; answer: string }): string | null {
  if (typeof input.passphrase !== 'string' || input.passphrase.length < MIN_PASSPHRASE_LENGTH)
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`
  if (input.passphrase !== input.confirm) return 'The two passphrases do not match.'
  if (typeof input.question !== 'string' || !input.question.trim()) return 'Recovery question is required.'
  if (typeof input.answer !== 'string' || !normaliseAnswer(input.answer)) return 'Recovery answer is required.'
  if (normaliseAnswer(input.answer) === normaliseAnswer(input.passphrase))
    return 'Recovery answer must be different from the passphrase.'
  return null
}
