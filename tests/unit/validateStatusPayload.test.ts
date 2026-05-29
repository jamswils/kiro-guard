/**
 * Unit tests for `validateStatusPayload()`
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 *
 * Requirement 3.1: `status` must be one of the AgentStatus values
 * Requirement 3.2: `message` must be a non-empty string of at most 120 characters
 * Requirement 3.3: `timestamp` must be a positive integer
 */

import { validateStatusPayload } from '../../src/shared/validation'
import type { AgentStatus } from '../../src/shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a valid baseline payload, allowing individual fields to be overridden. */
function makePayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: 'idle',
    message: 'Hello',
    timestamp: 1000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Requirement 3.1 — valid AgentStatus values
// ---------------------------------------------------------------------------

describe('validateStatusPayload — status field (Req 3.1)', () => {
  const validStatuses: AgentStatus[] = ['idle', 'working', 'waiting', 'asking', 'done', 'error']

  it.each(validStatuses)('accepts status "%s"', (status) => {
    expect(validateStatusPayload(makePayload({ status }))).toBe(true)
  })

  it('rejects an unknown status string', () => {
    expect(validateStatusPayload(makePayload({ status: 'running' }))).toBe(false)
  })

  it('rejects a numeric status', () => {
    expect(validateStatusPayload(makePayload({ status: 1 }))).toBe(false)
  })

  it('rejects a null status', () => {
    expect(validateStatusPayload(makePayload({ status: null }))).toBe(false)
  })

  it('rejects an undefined status (missing field)', () => {
    const { status: _omit, ...payload } = makePayload() as Record<string, unknown>
    expect(validateStatusPayload(payload)).toBe(false)
  })

  it('rejects status that is an empty string', () => {
    expect(validateStatusPayload(makePayload({ status: '' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Requirement 3.2 — message field
// ---------------------------------------------------------------------------

describe('validateStatusPayload — message field (Req 3.2)', () => {
  it('accepts message of length 1 (minimum boundary)', () => {
    expect(validateStatusPayload(makePayload({ message: 'a' }))).toBe(true)
  })

  it('accepts message of length 60', () => {
    expect(validateStatusPayload(makePayload({ message: 'x'.repeat(60) }))).toBe(true)
  })

  it('accepts message of length 120 (maximum boundary)', () => {
    expect(validateStatusPayload(makePayload({ message: 'x'.repeat(120) }))).toBe(true)
  })

  it('rejects message of length 121 (one over maximum)', () => {
    expect(validateStatusPayload(makePayload({ message: 'x'.repeat(121) }))).toBe(false)
  })

  it('rejects an empty message (length 0)', () => {
    expect(validateStatusPayload(makePayload({ message: '' }))).toBe(false)
  })

  it('rejects a numeric message', () => {
    expect(validateStatusPayload(makePayload({ message: 42 }))).toBe(false)
  })

  it('rejects a null message', () => {
    expect(validateStatusPayload(makePayload({ message: null }))).toBe(false)
  })

  it('rejects an undefined message (missing field)', () => {
    const { message: _omit, ...payload } = makePayload() as Record<string, unknown>
    expect(validateStatusPayload(payload)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Requirement 3.3 — timestamp field
// ---------------------------------------------------------------------------

describe('validateStatusPayload — timestamp field (Req 3.3)', () => {
  it('accepts timestamp of 1 (minimum positive integer)', () => {
    expect(validateStatusPayload(makePayload({ timestamp: 1 }))).toBe(true)
  })

  it('rejects timestamp of 0 (not positive)', () => {
    expect(validateStatusPayload(makePayload({ timestamp: 0 }))).toBe(false)
  })

  it('rejects timestamp of -1 (negative)', () => {
    expect(validateStatusPayload(makePayload({ timestamp: -1 }))).toBe(false)
  })

  it('rejects timestamp of 1.5 (non-integer)', () => {
    expect(validateStatusPayload(makePayload({ timestamp: 1.5 }))).toBe(false)
  })

  it('rejects a string timestamp', () => {
    expect(validateStatusPayload(makePayload({ timestamp: '1000' }))).toBe(false)
  })

  it('rejects a null timestamp', () => {
    expect(validateStatusPayload(makePayload({ timestamp: null }))).toBe(false)
  })

  it('rejects an undefined timestamp (missing field)', () => {
    const { timestamp: _omit, ...payload } = makePayload() as Record<string, unknown>
    expect(validateStatusPayload(payload)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Structural / payload-level checks
// ---------------------------------------------------------------------------

describe('validateStatusPayload — payload structure', () => {
  it('rejects null payload', () => {
    expect(validateStatusPayload(null)).toBe(false)
  })

  it('rejects a string payload', () => {
    expect(validateStatusPayload('{"status":"idle","message":"hi","timestamp":1}')).toBe(false)
  })

  it('rejects a number payload', () => {
    expect(validateStatusPayload(42)).toBe(false)
  })

  it('rejects an array payload', () => {
    expect(validateStatusPayload([])).toBe(false)
  })

  it('rejects undefined payload', () => {
    expect(validateStatusPayload(undefined)).toBe(false)
  })

  it('accepts a fully valid payload', () => {
    expect(
      validateStatusPayload({ status: 'working', message: 'Processing files', timestamp: 1700000000000 }),
    ).toBe(true)
  })

  it('accepts a valid optional spec phase', () => {
    expect(
      validateStatusPayload({
        status: 'working',
        message: 'Processing design',
        timestamp: 1700000000000,
        phase: 'design',
      }),
    ).toBe(true)
  })

  it('rejects an invalid optional spec phase', () => {
    expect(
      validateStatusPayload({
        status: 'working',
        message: 'Processing unknown phase',
        timestamp: 1700000000000,
        phase: 'planning',
      }),
    ).toBe(false)
  })
})
