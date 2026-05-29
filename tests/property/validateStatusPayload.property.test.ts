/**
 * Property-based tests for `validateStatusPayload()`
 *
 * Property 1: Valid StatusPayload passes validation
 *   For any object with a valid `status`,
 *   a non-empty `message` of at most 120 characters, and a positive integer
 *   `timestamp`, `validateStatusPayload()` must return `true`.
 *
 * Property 2: Invalid StatusPayload fails validation
 *   For any object where exactly one field is mutated to be missing, the wrong
 *   type, or out of range, `validateStatusPayload()` must return `false`.
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 */

import fc from 'fast-check'
import { validateStatusPayload } from '../../src/shared/validation'
import { MESSAGE_MAX_CHARS } from '../../src/shared/constants'

const validStatuses = ['idle', 'working', 'waiting', 'asking', 'done', 'error'] as const

/** Arbitrary that generates valid StatusPayload objects */
const validPayloadArb = fc.record({
  status: fc.constantFrom(...validStatuses),
  message: fc.string({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
  timestamp: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
})

// ---------------------------------------------------------------------------
// Arbitraries for invalid field values
// ---------------------------------------------------------------------------

/** Any value that is NOT a valid AgentStatus string */
const invalidStatusArb = fc.oneof(
  // Wrong type
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.record({ value: fc.string() }),
  // Valid-looking string but not in the enum
  fc.string().filter((s) => !validStatuses.includes(s as (typeof validStatuses)[number])),
)

/** Any value that is NOT a valid message (empty, too long, or wrong type) */
const invalidMessageArb = fc.oneof(
  // Wrong type
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.record({ value: fc.string() }),
  // Empty string
  fc.constant(''),
  // String exceeding max length
  fc.string({ minLength: MESSAGE_MAX_CHARS + 1, maxLength: MESSAGE_MAX_CHARS + 200 }),
)

/** Any value that is NOT a valid timestamp (non-positive, non-integer, or wrong type) */
const invalidTimestampArb = fc.oneof(
  // Wrong type
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.record({ value: fc.integer() }),
  // Zero
  fc.constant(0),
  // Negative integer
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: -1 }),
  // Non-integer (float with fractional part)
  fc
    .tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 999 }))
    .map(([whole, frac]) => whole + frac / 1000),
)

describe('validateStatusPayload — property tests', () => {
  it('Property 1: valid StatusPayload always passes validation', () => {
    fc.assert(
      fc.property(validPayloadArb, (payload) => {
        expect(validateStatusPayload(payload)).toBe(true)
      }),
    )
  })

  /**
   * Property 2: Invalid StatusPayload fails validation
   * Validates: Requirements 3.1, 3.2, 3.3
   */
  it('Property 2: payload with invalid status always fails validation', () => {
    fc.assert(
      fc.property(validPayloadArb, invalidStatusArb, (valid, badStatus) => {
        const payload = { ...valid, status: badStatus }
        expect(validateStatusPayload(payload)).toBe(false)
      }),
    )
  })

  it('Property 2: payload with missing status always fails validation', () => {
    fc.assert(
      fc.property(validPayloadArb, (valid) => {
        const { status: _omitted, ...payload } = valid
        expect(validateStatusPayload(payload)).toBe(false)
      }),
    )
  })

  it('Property 2: payload with invalid message always fails validation', () => {
    fc.assert(
      fc.property(validPayloadArb, invalidMessageArb, (valid, badMessage) => {
        const payload = { ...valid, message: badMessage }
        expect(validateStatusPayload(payload)).toBe(false)
      }),
    )
  })

  it('Property 2: payload with missing message always fails validation', () => {
    fc.assert(
      fc.property(validPayloadArb, (valid) => {
        const { message: _omitted, ...payload } = valid
        expect(validateStatusPayload(payload)).toBe(false)
      }),
    )
  })

  it('Property 2: payload with invalid timestamp always fails validation', () => {
    fc.assert(
      fc.property(validPayloadArb, invalidTimestampArb, (valid, badTimestamp) => {
        const payload = { ...valid, timestamp: badTimestamp }
        expect(validateStatusPayload(payload)).toBe(false)
      }),
    )
  })

  it('Property 2: payload with missing timestamp always fails validation', () => {
    fc.assert(
      fc.property(validPayloadArb, (valid) => {
        const { timestamp: _omitted, ...payload } = valid
        expect(validateStatusPayload(payload)).toBe(false)
      }),
    )
  })
})
