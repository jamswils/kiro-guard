/**
 * Property-based tests for `StatusManager.processStatusUpdate()`
 *
 * Property 3: Invalid input leaves pet state unchanged
 *   For any `status.json` content that is either invalid JSON or a JSON object
 *   that fails schema validation, the StatusManager SHALL discard the update
 *   and `getCurrentStatus()` SHALL remain equal to its state before the update
 *   was attempted.
 *
 * **Validates: Requirements 3.4, 3.5**
 *
 * Property 4: Valid StatusPayload is dispatched to the state machine
 *   For any valid `StatusPayload` written to `status.json`, the StatusManager
 *   SHALL call the registered subscriber callback with the payload's `status`
 *   and `message` values.
 *
 * **Validates: Requirements 2.4**
 */

import fc from 'fast-check'
import fs from 'fs'
import { statusManager } from '../../src/main/statusManager'
import { MESSAGE_MAX_CHARS, DEBOUNCE_MS } from '../../src/shared/constants'
import type { StatusPayload } from '../../src/shared/types'

// ---------------------------------------------------------------------------
// Mock fs so we can control what processStatusUpdate "reads"
// ---------------------------------------------------------------------------

jest.mock('fs')

const mockedReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validStatuses = ['idle', 'working', 'waiting', 'asking', 'done', 'error'] as const

/** Reset the StatusManager's internal state between tests */
function resetStatusManager(): void {
  // Access private field via type cast to reset state between property runs
  (statusManager as unknown as { currentStatus: StatusPayload | null }).currentStatus = null
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates strings that are NOT valid JSON.
 * We produce strings and filter out those that happen to parse successfully.
 */
const invalidJsonStringArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => {
    try {
      JSON.parse(s)
      return false // valid JSON — skip
    } catch {
      return true // invalid JSON — keep
    }
  })

/**
 * Generates JSON objects that fail schema validation.
 * We cover each failure mode independently.
 */
const invalidSchemaObjectArb = fc.oneof(
  // Wrong / missing status
  fc.record({
    status: fc.string().filter((s) => !validStatuses.includes(s as (typeof validStatuses)[number])),
    message: fc.string({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
    timestamp: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  }),
  // Empty message
  fc.record({
    status: fc.constantFrom(...validStatuses),
    message: fc.constant(''),
    timestamp: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  }),
  // Message too long
  fc.record({
    status: fc.constantFrom(...validStatuses),
    message: fc.string({ minLength: MESSAGE_MAX_CHARS + 1, maxLength: MESSAGE_MAX_CHARS + 200 }),
    timestamp: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  }),
  // Non-positive timestamp
  fc.record({
    status: fc.constantFrom(...validStatuses),
    message: fc.string({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
    timestamp: fc.integer({ min: -100_000, max: 0 }),
  }),
  // Non-integer timestamp (float with fractional part)
  fc
    .tuple(
      fc.constantFrom(...validStatuses),
      fc.string({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 1, max: 999 }),
    )
    .map(([status, message, whole, frac]) => ({
      status,
      message,
      timestamp: whole + frac / 1000,
    })),
  // Missing status field
  fc.record({
    message: fc.string({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
    timestamp: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  }),
  // Missing message field
  fc.record({
    status: fc.constantFrom(...validStatuses),
    timestamp: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  }),
  // Missing timestamp field
  fc.record({
    status: fc.constantFrom(...validStatuses),
    message: fc.string({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
  }),
  // Null payload
  fc.constant(null),
  // Non-object primitive
  fc.oneof(fc.integer(), fc.boolean(), fc.string()),
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StatusManager — property tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetStatusManager()
  })

  /**
   * Property 3a: Invalid JSON leaves state unchanged
   * Validates: Requirement 3.4
   */
  it('Property 3: invalid JSON content leaves getCurrentStatus() unchanged', () => {
    fc.assert(
      fc.property(invalidJsonStringArb, (invalidJson) => {
        // Capture state before the update
        const stateBefore = statusManager.getCurrentStatus()

        // Mock fs.readFileSync to return invalid JSON
        mockedReadFileSync.mockReturnValue(invalidJson)

        // Attempt to process the update
        statusManager.processStatusUpdate('/dummy/path/status.json')

        // State must be unchanged
        expect(statusManager.getCurrentStatus()).toEqual(stateBefore)
      }),
    )
  })

  /**
   * Property 3b: Valid JSON that fails schema validation leaves state unchanged
   * Validates: Requirement 3.5
   */
  it('Property 3: valid JSON failing schema validation leaves getCurrentStatus() unchanged', () => {
    fc.assert(
      fc.property(invalidSchemaObjectArb, (invalidObject) => {
        // Capture state before the update
        const stateBefore = statusManager.getCurrentStatus()

        // Mock fs.readFileSync to return the serialised invalid object
        const content = JSON.stringify(invalidObject)
        mockedReadFileSync.mockReturnValue(content)

        // Attempt to process the update
        statusManager.processStatusUpdate('/dummy/path/status.json')

        // State must be unchanged
        expect(statusManager.getCurrentStatus()).toEqual(stateBefore)
      }),
    )
  })

  /**
   * Property 3c: Invalid input after a known valid state leaves that state intact
   * Validates: Requirements 3.4, 3.5
   *
   * This variant seeds the StatusManager with a known valid state first, then
   * verifies that a subsequent invalid update does not overwrite it.
   */
  it('Property 3: invalid input after a valid state preserves the valid state', () => {
    const knownValidPayload: StatusPayload = {
      status: 'idle',
      message: 'Kiro is ready',
      timestamp: 1_718_000_000_000,
    }

    fc.assert(
      fc.property(
        fc.oneof(
          invalidJsonStringArb,
          invalidSchemaObjectArb.map((obj) => JSON.stringify(obj)),
        ),
        (invalidContent) => {
          // Seed with a known valid state
          resetStatusManager()
          ;(statusManager as unknown as { currentStatus: StatusPayload | null }).currentStatus =
            knownValidPayload

          // Mock fs.readFileSync to return invalid content
          mockedReadFileSync.mockReturnValue(invalidContent)

          // Attempt to process the update
          statusManager.processStatusUpdate('/dummy/path/status.json')

          // The known valid state must still be present
          expect(statusManager.getCurrentStatus()).toEqual(knownValidPayload)
        },
      ),
    )
  })

  // ---------------------------------------------------------------------------
  // Property 4: Valid StatusPayload is dispatched to the state machine
  // ---------------------------------------------------------------------------

  /**
   * Arbitrary that generates valid StatusPayload objects.
   *
   * To avoid the debounce logic skipping updates (same status + timestamp
   * difference < 50ms), we reset `currentStatus` to null before each run so
   * the debounce guard is never triggered.
   */
  const validStatusPayloadArb = fc.record({
    status: fc.constantFrom(...validStatuses),
    message: fc.string({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
    timestamp: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  })

  /**
   * Property 4: Valid StatusPayload is dispatched to the subscriber callback
   * Validates: Requirements 2.4
   *
   * For any valid `StatusPayload`, when `processStatusUpdate()` reads it from
   * the file, the registered `onStatusChange` subscriber SHALL be called with
   * the payload's `status` and `message` values.
   */
  it('Property 4: valid StatusPayload is dispatched to the onStatusChange subscriber', () => {
    const callback = jest.fn()
    statusManager.onStatusChange(callback)

    fc.assert(
      fc.property(validStatusPayloadArb, (payload) => {
        // Reset internal state so debounce never skips the update
        resetStatusManager()
        callback.mockClear()

        // Mock fs.readFileSync to return the serialised valid payload
        mockedReadFileSync.mockReturnValue(JSON.stringify(payload))

        // Trigger the update
        statusManager.processStatusUpdate('/dummy/path/status.json')

        // The subscriber must have been called exactly once
        expect(callback).toHaveBeenCalledTimes(1)

        // The dispatched payload must carry the correct status and message
        const dispatched: StatusPayload = callback.mock.calls[0][0]
        expect(dispatched.status).toBe(payload.status)
        expect(dispatched.message).toBe(payload.message)
      }),
    )
  })

  // ---------------------------------------------------------------------------
  // Property 5: Debounce skips identical rapid repeats
  // ---------------------------------------------------------------------------

  /**
   * Arbitrary that generates a sequence of N (N >= 2) valid StatusPayload
   * objects all sharing the same status and message, with timestamps within a
   * 50ms window of each other (i.e., each subsequent timestamp is within
   * DEBOUNCE_MS of the first payload's timestamp).
   *
   * The first payload acts as the "dispatched" baseline; all subsequent
   * payloads should be debounced because:
   *   - They are identical to the last dispatched payload except timestamp
   *   - Their timestamp difference from the last dispatched payload is < 50ms
   */
  const debounceSequenceArb = fc
    .tuple(
      // N: number of subsequent payloads (at least 1, so total sequence >= 2)
      fc.integer({ min: 1, max: 5 }),
      // The shared status for all payloads in the sequence
      fc.constantFrom(...validStatuses),
      // Base timestamp for the first (dispatched) payload
      fc.integer({ min: 1_000_000, max: Number.MAX_SAFE_INTEGER - 100 }),
      // Valid message for the first payload
      fc.string({ minLength: 1, maxLength: MESSAGE_MAX_CHARS }),
    )
    .chain(([n, status, baseTimestamp, firstMessage]) =>
      fc
        .array(
          fc.tuple(
            // Each subsequent timestamp is within [1, DEBOUNCE_MS - 1] of the base
            fc.integer({ min: 1, max: DEBOUNCE_MS - 1 }),
            fc.constant(firstMessage),
          ),
          { minLength: n, maxLength: n },
        )
        .map((subsequentEntries) => {
          const firstPayload: StatusPayload = {
            status,
            message: firstMessage,
            timestamp: baseTimestamp,
          }
          const subsequentPayloads: StatusPayload[] = subsequentEntries.map(
            ([offset, message]) => ({
              status,
              message,
              timestamp: baseTimestamp + offset,
            }),
          )
          return { firstPayload, subsequentPayloads }
        }),
    )

  /**
   * Property 5: Debounce skips identical rapid repeats
   * **Validates: Requirements 2.5**
   *
   * For a sequence of N valid payloads all sharing the same status, message,
   * phase, and context, with timestamps within the 50ms debounce window of the
   * first dispatched payload, the subscriber SHALL be called exactly once (for
   * the first payload) and NOT called for any subsequent payloads in the window.
   *
   * The debounce check in `processStatusUpdate` is:
   *   if lastPayload status/message/phase/context match payload AND
   *      (payload.timestamp - lastPayload.timestamp) < DEBOUNCE_MS → skip
   *
   * So after the first payload is dispatched and stored as `currentStatus`,
   * all subsequent identical payloads with a timestamp within DEBOUNCE_MS of
   * that first payload are skipped.
   */
  it('Property 5: subsequent identical payloads within the debounce window are skipped', () => {
    const callback = jest.fn()
    statusManager.onStatusChange(callback)

    fc.assert(
      fc.property(debounceSequenceArb, ({ firstPayload, subsequentPayloads }) => {
        // Reset state so the first payload is always dispatched fresh
        resetStatusManager()
        callback.mockClear()

        // --- Step 1: dispatch the first payload (should be dispatched) ---
        mockedReadFileSync.mockReturnValue(JSON.stringify(firstPayload))
        statusManager.processStatusUpdate('/dummy/path/status.json')

        // The first payload must be dispatched exactly once
        expect(callback).toHaveBeenCalledTimes(1)
        const firstDispatched: StatusPayload = callback.mock.calls[0][0]
        expect(firstDispatched.status).toBe(firstPayload.status)
        expect(firstDispatched.message).toBe(firstPayload.message)

        // --- Step 2: process subsequent payloads (all should be debounced) ---
        callback.mockClear()

        for (const subsequentPayload of subsequentPayloads) {
          mockedReadFileSync.mockReturnValue(JSON.stringify(subsequentPayload))
          statusManager.processStatusUpdate('/dummy/path/status.json')
        }

        // None of the subsequent payloads should have triggered the subscriber
        expect(callback).toHaveBeenCalledTimes(0)

        // currentStatus should still be the first payload (debounced ones were skipped)
        const currentStatus = statusManager.getCurrentStatus()
        expect(currentStatus?.status).toBe(firstPayload.status)
        expect(currentStatus?.message).toBe(firstPayload.message)
        expect(currentStatus?.timestamp).toBe(firstPayload.timestamp)
      }),
    )
  })
})
