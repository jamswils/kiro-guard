/**
 * Shared constants for Kiro Buddy
 * Used by both main and renderer processes
 */

import type { PetState, AnimationKey } from './types'

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** Debounce window for rapid status.json file changes (milliseconds) */
export const DEBOUNCE_MS = 50

/** Duration before tooltip auto-hides after 'done' or 'error' states (milliseconds) */
export const AUTO_HIDE_MS = 4000

/** Minimum interval between drag position IPC messages (milliseconds, ~60fps) */
export const DRAG_THROTTLE_MS = 16

// ---------------------------------------------------------------------------
// Display constants
// ---------------------------------------------------------------------------

/** Maximum characters shown in the tooltip bubble before truncation with ellipsis */
export const TOOLTIP_MAX_CHARS = 42

/** Maximum characters allowed in a StatusPayload message field */
export const MESSAGE_MAX_CHARS = 120

// ---------------------------------------------------------------------------
// State → Animation mapping
// ---------------------------------------------------------------------------

/**
 * Maps each PetState to its corresponding sprite AnimationKey.
 * Used by PetStateMachine to determine which animation to play on transition.
 */
export const STATE_TO_ANIMATION_MAP: Record<PetState, AnimationKey> = {
  idle: 'idle',
  working: 'working',
  waiting: 'waiting',
  asking: 'asking',
  done: 'done',
  error: 'error',
}

// ---------------------------------------------------------------------------
// Human-readable state titles (used in toast notifications)
// ---------------------------------------------------------------------------

/**
 * Maps each PetState to a human-readable title string.
 * Used as the notification title in ToastNotifier.
 */
export const STATE_TITLES: Record<PetState, string> = {
  idle: 'Kiro is ready',
  working: 'Kiro is working',
  waiting: 'Kiro is waiting for input',
  asking: 'Kiro is asking for input',
  done: 'Kiro is done',
  error: 'Kiro encountered an error',
}

// ---------------------------------------------------------------------------
// Valid state transitions
// ---------------------------------------------------------------------------

/**
 * The set of valid (from → to) state transition pairs for PetStateMachine.
 * Any transition not in this set is rejected with a warning log.
 *
 * Valid transitions:
 *   idle    → working
 *   idle    → error
 *   working → done
 *   working → waiting
 *   working → error
 *   waiting → working
 *   waiting → error
 *   done    → working
 *   done    → idle
 *   error   → idle
 */
export const VALID_TRANSITIONS: ReadonlyArray<readonly [PetState, PetState]> = [
  ['idle', 'working'],
  ['idle', 'asking'],
  ['idle', 'error'],
  ['working', 'done'],
  ['working', 'waiting'],
  ['working', 'asking'],
  ['working', 'error'],
  ['waiting', 'working'],
  ['waiting', 'done'],
  ['waiting', 'error'],
  ['asking', 'working'],
  ['asking', 'done'],
  ['asking', 'error'],
  ['asking', 'idle'],
  ['done', 'working'],
  ['done', 'idle'],
  ['done', 'done'],
  ['error', 'idle'],
] as const

/**
 * Checks whether a transition from `from` to `to` is valid.
 * Convenience helper used by PetStateMachine.dispatch().
 */
export function isValidTransition(from: PetState, to: PetState): boolean {
  return VALID_TRANSITIONS.some(([f, t]) => f === from && t === to)
}
