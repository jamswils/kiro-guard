/**
 * Runtime validation for Kiro Buddy shared data structures.
 *
 * All validators are pure functions with no side effects:
 *   - Accept `unknown` input (the result of JSON.parse or untrusted IPC data)
 *   - Return a boolean — never throw
 *   - Do not mutate the input
 */

import type { StatusPayload } from './types'
import { MESSAGE_MAX_CHARS } from './constants'

/** The exhaustive set of valid AgentStatus string values. */
const VALID_STATUSES = new Set<string>(['idle', 'working', 'waiting', 'asking', 'done', 'error'])
const VALID_PHASES = new Set<string>(['design', 'requirements', 'tasks'])

/**
 * Validates that `payload` conforms to the `StatusPayload` schema.
 *
 * Rules (per Requirements 3.1 – 3.3):
 *   - `payload` must be a non-null object
 *   - `status`    must be one of: 'idle' | 'working' | 'waiting' | 'done' | 'error'
 *   - `message`   must be a non-empty string of at most 120 characters
 *   - `timestamp` must be a positive integer (> 0, no decimals)
 *
 * @param payload - The value to validate (typically the result of JSON.parse)
 * @returns `true` if `payload` is a valid `StatusPayload`, `false` otherwise
 */
export function validateStatusPayload(payload: unknown): payload is StatusPayload {
  // Must be a non-null object
  if (payload === null || typeof payload !== 'object') {
    return false
  }

  const p = payload as Record<string, unknown>

  // --- status field ---
  if (typeof p['status'] !== 'string') {
    return false
  }
  if (!VALID_STATUSES.has(p['status'])) {
    return false
  }

  // --- message field ---
  if (typeof p['message'] !== 'string') {
    return false
  }
  if (p['message'].length === 0 || p['message'].length > MESSAGE_MAX_CHARS) {
    return false
  }

  // --- timestamp field ---
  if (typeof p['timestamp'] !== 'number') {
    return false
  }
  if (p['timestamp'] <= 0 || !Number.isInteger(p['timestamp'])) {
    return false
  }

  // --- optional phase field ---
  if (p['phase'] !== undefined) {
    if (typeof p['phase'] !== 'string' || !VALID_PHASES.has(p['phase'])) {
      return false
    }
  }

  // --- optional context field ---
  if (p['context'] !== undefined) {
    if (typeof p['context'] !== 'string' || p['context'].length > MESSAGE_MAX_CHARS) {
      return false
    }
  }

  return true
}
