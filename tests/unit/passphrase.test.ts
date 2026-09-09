/**
 * passphrase.ts — verifier round-trips, rejection paths, recovery normalisation.
 * Iterations are lowered in tests so the suite stays fast; the default is pinned.
 */
import {
  makeVerifier, verifySecret, makeRecovery, verifyRecovery, normaliseAnswer,
  validatePassphraseSetup, PBKDF2_ITERATIONS, MIN_PASSPHRASE_LENGTH,
} from '../../src/main/passphrase'

const IT = 2_000

describe('passphrase verifiers', () => {
  it('pins the production iteration count', () => {
    expect(PBKDF2_ITERATIONS).toBe(300_000)
  })

  it('round-trips a passphrase and rejects a wrong one', () => {
    const v = makeVerifier('correct horse battery', IT)
    expect(v.iterations).toBe(IT)
    expect(Buffer.from(v.salt, 'base64').length).toBe(32)
    expect(verifySecret('correct horse battery', v)).toBe(true)
    expect(verifySecret('correct horse batter', v)).toBe(false)
    expect(verifySecret('', v)).toBe(false)
  })

  it('never stores the secret and salts every verifier differently', () => {
    const a = makeVerifier('same', IT)
    const b = makeVerifier('same', IT)
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
    expect(JSON.stringify(a)).not.toContain('same')
  })

  it('refuses malformed or weakened verifiers instead of accepting anything', () => {
    expect(verifySecret('x', undefined)).toBe(false)
    expect(verifySecret('x', { salt: 'AA==', hash: 'not-32-bytes', iterations: IT })).toBe(false)
    const weak = { ...makeVerifier('x', IT), iterations: 10 }   // tampered on disk
    expect(verifySecret('x', weak)).toBe(false)
  })

  it('recovery answers ignore case and whitespace', () => {
    expect(normaliseAnswer('  Van Der Berg ')).toBe('vanderberg')
    const r = makeRecovery("Mother's maiden name", 'Van Der Berg', IT)
    expect(r.question).toBe("Mother's maiden name")
    expect(verifyRecovery('vanderberg', r)).toBe(true)
    expect(verifyRecovery('VANDER  BERG', r)).toBe(true)
    expect(verifyRecovery('vanderburg', r)).toBe(false)
    expect(verifyRecovery('x', undefined)).toBe(false)
  })

  it('validates a setup form the same way the settings window does', () => {
    const ok = { passphrase: 'abcdef', confirm: 'abcdef', question: 'Q?', answer: 'A' }
    expect(validatePassphraseSetup(ok)).toBeNull()
    expect(validatePassphraseSetup({ ...ok, passphrase: 'abc', confirm: 'abc' })).toMatch(String(MIN_PASSPHRASE_LENGTH))
    expect(validatePassphraseSetup({ ...ok, confirm: 'abcdeg' })).toMatch(/do not match/)
    expect(validatePassphraseSetup({ ...ok, question: '  ' })).toMatch(/question/)
    expect(validatePassphraseSetup({ ...ok, answer: '' })).toMatch(/answer/)
    expect(validatePassphraseSetup({ ...ok, answer: 'ABC DEF', passphrase: 'abcdef', confirm: 'abcdef' })).toMatch(/different/)
  })
})
