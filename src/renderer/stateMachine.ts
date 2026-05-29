/**
 * PetStateMachine — manages valid state transitions and coordinates UI updates.
 *
 * Responsibilities:
 * - Enforce valid state transitions (reject invalid ones with a warning log)
 * - Trigger animation changes on transition
 * - Trigger tooltip updates on transition
 * - Fire toast notifications for `done` and `error` transitions (if enabled)
 * - Notify registered transition listeners
 */

import type {
  PetState,
  PetStateMachine,
  AnimationConfig,
  AnimationRenderer,
  TooltipBubble,
  ToastNotifier,
} from '../shared/types'

import {
  isValidTransition,
  STATE_TO_ANIMATION_MAP,
  STATE_TITLES,
  AUTO_HIDE_MS,
} from '../shared/constants'

// ---------------------------------------------------------------------------
// Loop settings per state
// ---------------------------------------------------------------------------

/**
 * Returns whether the animation for a given state should loop continuously.
 * - idle, working, waiting: loop = true
 * - done (x3), error (x2): loop = false (AnimationRenderer handles repeat count)
 */
function shouldLoop(state: PetState): boolean {
  return state === 'idle' || state === 'working' || state === 'waiting' || state === 'asking'
}

// ---------------------------------------------------------------------------
// PetStateMachineImpl
// ---------------------------------------------------------------------------

export class PetStateMachineImpl implements PetStateMachine {
  private currentState: PetState = 'idle'
  private transitionListeners: Array<(from: PetState, to: PetState) => void> = []

  constructor(
    private readonly animationRenderer: AnimationRenderer,
    private readonly tooltipBubble: TooltipBubble,
    private readonly toastNotifier: ToastNotifier,
  ) {}

  /**
   * Attempt to transition to `newState` with an optional `message`.
   *
   * - Validates the transition against VALID_TRANSITIONS.
   * - If invalid: logs a warning and returns without changing state.
   * - If valid:
   *   1. Updates current state.
   *   2. Plays the corresponding animation.
   *   3. Shows/hides the tooltip.
   *   4. Fires a toast notification for `done` or `error`.
   *   5. Notifies all registered transition listeners.
   */
  dispatch(newState: PetState, message: string): boolean {
    const previousState = this.currentState

    if (previousState === newState) {
      this.applyState(previousState, newState, message)
      return true
    }

    if (!isValidTransition(previousState, newState)) {
      console.log(`Invalid transition: ${previousState} → ${newState}`)
      return false
    }

    this.applyState(previousState, newState, message)
    return true
  }

  private applyState(previousState: PetState, newState: PetState, message: string): void {
    // Update state
    this.currentState = newState

    // Trigger animation
    const animKey = STATE_TO_ANIMATION_MAP[newState]
    const animConfig: AnimationConfig = {
      key: animKey,
      loop: shouldLoop(newState),
      speed: 1.0,
    }
    this.animationRenderer.play(animConfig)

    // Update tooltip
    if (message && message.length > 0) {
      this.tooltipBubble.show(message)
      if (newState === 'done' || newState === 'error') {
        this.tooltipBubble.setAutoHide(AUTO_HIDE_MS)
      }
    } else {
      this.tooltipBubble.hide()
    }

    // Fire toast notification for terminal states
    if (newState === 'done' || newState === 'error') {
      this.toastNotifier.notify(STATE_TITLES[newState], message)
    }

    // Notify transition listeners
    for (const listener of this.transitionListeners) {
      listener(previousState, newState)
    }
  }

  /**
   * Returns the current `PetState`.
   */
  getCurrentState(): PetState {
    return this.currentState
  }

  /**
   * Registers a transition listener.
   * Each listener receives `(previousState, newState)` exactly once per transition.
   */
  onTransition(callback: (from: PetState, to: PetState) => void): void {
    this.transitionListeners.push(callback)
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new `PetStateMachine` instance initialized to `idle`.
 *
 * @param animationRenderer - Handles sprite animation playback
 * @param tooltipBubble     - Manages the speech-bubble tooltip overlay
 * @param toastNotifier     - Fires OS-level toast notifications
 */
export function createPetStateMachine(
  animationRenderer: AnimationRenderer,
  tooltipBubble: TooltipBubble,
  toastNotifier: ToastNotifier,
): PetStateMachine {
  return new PetStateMachineImpl(animationRenderer, tooltipBubble, toastNotifier)
}
