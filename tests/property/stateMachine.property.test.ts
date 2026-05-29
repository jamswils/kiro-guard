/**
 * Property-based tests for `PetStateMachineImpl`
 *
 * Property 6: Valid state transitions update state and trigger animation
 *   For any valid (from, to) pair from the VALID_TRANSITIONS table, calling
 *   `dispatch(to, message)` on a state machine currently in `from` SHALL:
 *     1. Update `getCurrentState()` to return `to`
 *     2. Call `animationRenderer.play()` with the correct animation key
 *        (as defined in STATE_TO_ANIMATION_MAP)
 *
 * **Validates: Requirements 4.1, 4.2**
 */

import fc from 'fast-check'
import { PetStateMachineImpl } from '../../src/renderer/stateMachine'
import {
  VALID_TRANSITIONS,
  STATE_TO_ANIMATION_MAP,
} from '../../src/shared/constants'
import type {
  AnimationRenderer,
  TooltipBubble,
  ToastNotifier,
  PetState,
  AnimationConfig,
} from '../../src/shared/types'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeAnimationRenderer(): jest.Mocked<AnimationRenderer> {
  return {
    play: jest.fn(),
    stop: jest.fn(),
    getCurrentAnimation: jest.fn().mockReturnValue(null),
  }
}

function makeTooltipBubble(): jest.Mocked<TooltipBubble> {
  return {
    show: jest.fn(),
    hide: jest.fn(),
    update: jest.fn(),
    setAutoHide: jest.fn(),
  }
}

function makeToastNotifier(): jest.Mocked<ToastNotifier> {
  return {
    configure: jest.fn(),
    notify: jest.fn(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a path of valid transitions that leads from 'idle' to the desired
 * `target` state. Returns the sequence of states to dispatch (excluding the
 * starting 'idle' state).
 *
 * We use a simple BFS over VALID_TRANSITIONS to find the shortest path.
 */
function pathFromIdleTo(target: PetState): PetState[] {
  if (target === 'idle') return []

  const graph = new Map<PetState, PetState[]>()
  for (const [from, to] of VALID_TRANSITIONS) {
    if (!graph.has(from)) graph.set(from, [])
    graph.get(from)!.push(to)
  }

  // BFS
  const queue: Array<{ state: PetState; path: PetState[] }> = [
    { state: 'idle', path: [] },
  ]
  const visited = new Set<PetState>(['idle'])

  while (queue.length > 0) {
    const { state, path } = queue.shift()!
    for (const next of graph.get(state) ?? []) {
      const newPath = [...path, next]
      if (next === target) return newPath
      if (!visited.has(next)) {
        visited.add(next)
        queue.push({ state: next, path: newPath })
      }
    }
  }

  throw new Error(`No path from 'idle' to '${target}'`)
}

/**
 * Create a fresh `PetStateMachineImpl` that starts in `fromState` by
 * replaying the minimal sequence of valid transitions from 'idle'.
 * Returns the machine and a fresh `animationRenderer` mock (cleared after
 * the warm-up dispatches so only the final dispatch is observed).
 */
function createMachineAt(
  fromState: PetState,
): {
  machine: PetStateMachineImpl
  animationRenderer: jest.Mocked<AnimationRenderer>
  tooltipBubble: jest.Mocked<TooltipBubble>
  toastNotifier: jest.Mocked<ToastNotifier>
} {
  const animationRenderer = makeAnimationRenderer()
  const tooltipBubble = makeTooltipBubble()
  const toastNotifier = makeToastNotifier()

  const machine = new PetStateMachineImpl(animationRenderer, tooltipBubble, toastNotifier)

  // Warm up: drive the machine from 'idle' to `fromState`
  const warmUpPath = pathFromIdleTo(fromState)
  for (const state of warmUpPath) {
    machine.dispatch(state, 'warm-up')
  }

  // Clear all mock call history so only the test dispatch is observed
  animationRenderer.play.mockClear()
  animationRenderer.stop.mockClear()
  tooltipBubble.show.mockClear()
  tooltipBubble.hide.mockClear()
  toastNotifier.notify.mockClear()

  return { machine, animationRenderer, tooltipBubble, toastNotifier }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** All possible PetState values */
const ALL_STATES: PetState[] = ['idle', 'working', 'waiting', 'asking', 'done', 'error']

/**
 * Generates a random valid (from, to) transition pair from VALID_TRANSITIONS.
 */
const validTransitionArb = fc.constantFrom(...VALID_TRANSITIONS)

/**
 * Generates a random INVALID (from, to) transition pair.
 * Builds all state combinations and filters out the valid ones.
 */
const invalidTransitionArb: fc.Arbitrary<[PetState, PetState]> = fc.constantFrom(
  ...(ALL_STATES.flatMap((from) =>
    ALL_STATES.map((to) => [from, to] as [PetState, PetState]),
  ).filter(([from, to]) =>
    from !== to && !VALID_TRANSITIONS.some(([f, t]) => f === from && t === to),
  )),
)

/**
 * Generates a non-empty message string (up to 120 chars, matching MESSAGE_MAX_CHARS).
 */
const messageArb = fc.string({ minLength: 1, maxLength: 120 })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PetStateMachineImpl — property tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  /**
   * Property 6: Valid state transitions update state and trigger animation
   * **Validates: Requirements 4.1, 4.2**
   *
   * For any valid (from, to) pair:
   *   - After `dispatch(to, message)`, `getCurrentState()` returns `to`
   *   - `animationRenderer.play()` is called exactly once with the correct
   *     animation key from STATE_TO_ANIMATION_MAP
   */
  it('Property 6: valid transitions update getCurrentState() and trigger animationRenderer.play()', () => {
    fc.assert(
      fc.property(validTransitionArb, messageArb, ([from, to], message) => {
        // Arrange: create a machine already in the `from` state
        const { machine, animationRenderer } = createMachineAt(from)

        // Pre-condition: machine is in the expected `from` state
        expect(machine.getCurrentState()).toBe(from)

        // Act: dispatch the valid transition
        machine.dispatch(to, message)

        // Assert 1: state updated to `to`
        expect(machine.getCurrentState()).toBe(to)

        // Assert 2: animation played with the correct key
        expect(animationRenderer.play).toHaveBeenCalledTimes(1)
        const calledConfig: AnimationConfig = animationRenderer.play.mock.calls[0][0]
        expect(calledConfig.key).toBe(STATE_TO_ANIMATION_MAP[to])
      }),
    )
  })

  /**
   * Property 7: Invalid state transitions leave state unchanged
   * **Validates: Requirements 4.1, 4.3**
   *
   * For any INVALID (from, to) pair (i.e. not in VALID_TRANSITIONS):
   *   - After `dispatch(to, message)`, `getCurrentState()` still returns `from`
   *   - `animationRenderer.play()` is NOT called
   */
  it('Property 7: invalid transitions leave getCurrentState() unchanged and do not call animationRenderer.play()', () => {
    fc.assert(
      fc.property(invalidTransitionArb, messageArb, ([from, to], message) => {
        // Arrange: create a machine already in the `from` state
        const { machine, animationRenderer } = createMachineAt(from)

        // Pre-condition: machine is in the expected `from` state
        expect(machine.getCurrentState()).toBe(from)

        // Act: attempt the invalid transition
        machine.dispatch(to, message)

        // Assert 1: state remains unchanged
        expect(machine.getCurrentState()).toBe(from)

        // Assert 2: animation renderer was NOT called
        expect(animationRenderer.play).not.toHaveBeenCalled()
      }),
    )
  })

  /**
   * Property 16: Transition listeners receive correct from/to values
   * **Validates: Requirements 4.5**
   *
   * For any valid (from, to) transition pair and N registered listeners (N ∈ [1, 5]):
   *   - Each listener is called exactly once per transition
   *   - Each listener receives `(from, to)` as arguments
   */
  it('Property 16: transition listeners receive correct (from, to) values and are called exactly once', () => {
    fc.assert(
      fc.property(
        validTransitionArb,
        messageArb,
        fc.integer({ min: 1, max: 5 }),
        ([from, to], message, listenerCount) => {
          // Arrange: create a machine already in the `from` state
          const { machine } = createMachineAt(from)

          // Register N listeners, each tracking their call history
          const listenerCalls: Array<Array<[PetState, PetState]>> = []
          for (let i = 0; i < listenerCount; i++) {
            const calls: Array<[PetState, PetState]> = []
            listenerCalls.push(calls)
            machine.onTransition((prevState, newState) => {
              calls.push([prevState, newState])
            })
          }

          // Pre-condition: machine is in the expected `from` state
          expect(machine.getCurrentState()).toBe(from)

          // Act: dispatch the valid transition
          machine.dispatch(to, message)

          // Assert: each listener was called exactly once with (from, to)
          for (let i = 0; i < listenerCount; i++) {
            expect(listenerCalls[i]).toHaveLength(1)
            expect(listenerCalls[i][0]).toEqual([from, to])
          }
        },
      ),
    )
  })

  /**
   * Property 8: State-to-animation mapping is correct for all states
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
   *
   * For each valid PetState value:
   *   - Dispatch a valid transition to that state
   *   - Assert `animationRenderer.play()` is called with:
   *     - `key === STATE_TO_ANIMATION_MAP[state]`
   *     - `loop === true` for idle, working, waiting
   *     - `loop === false` for done, error
   *
   * Uses `fc.constantFrom` over all states for exhaustive coverage.
   */
  it('Property 8: state-to-animation mapping is correct for all states', () => {
    // Map each target state to a valid (from, to) transition that reaches it
    const stateToTransition: Record<PetState, [PetState, PetState]> = {
      idle:    ['done',    'idle'],
      working: ['idle',    'working'],
      waiting: ['working', 'waiting'],
      asking:  ['working', 'asking'],
      done:    ['working', 'done'],
      error:   ['idle',    'error'],
    }

    // Loop settings: true for ambient states, false for terminal states
    const expectedLoop: Record<PetState, boolean> = {
      idle:    true,
      working: true,
      waiting: true,
      asking:  true,
      done:    false,
      error:   false,
    }

    fc.assert(
      fc.property(fc.constantFrom(...ALL_STATES), (targetState) => {
        const [fromState, toState] = stateToTransition[targetState]

        // Arrange: create a machine already in the `from` state
        const { machine, animationRenderer } = createMachineAt(fromState)

        // Pre-condition: machine is in the expected `from` state
        expect(machine.getCurrentState()).toBe(fromState)

        // Act: dispatch the valid transition to `targetState`
        machine.dispatch(toState, 'test message')

        // Assert 1: state updated to `targetState`
        expect(machine.getCurrentState()).toBe(targetState)

        // Assert 2: animation played exactly once
        expect(animationRenderer.play).toHaveBeenCalledTimes(1)

        // Assert 3: correct animation key and loop setting
        const calledConfig: AnimationConfig = animationRenderer.play.mock.calls[0][0]
        expect(calledConfig.key).toBe(STATE_TO_ANIMATION_MAP[targetState])
        expect(calledConfig.loop).toBe(expectedLoop[targetState])
      }),
    )
  })
})
