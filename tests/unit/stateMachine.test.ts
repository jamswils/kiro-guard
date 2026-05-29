/**
 * Unit tests for `PetStateMachineImpl`
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5
 *
 * Requirement 4.1: Machine initializes to `idle` state
 * Requirement 4.2: Valid transitions succeed and update state
 * Requirement 4.3: Invalid transitions are rejected with a log message
 * Requirement 4.4: Tooltip shown/hidden based on message content; auto-hide set for done/error
 * Requirement 4.5: Toast notification fired for `done` and `error` only
 */

import type { AnimationRenderer, TooltipBubble, ToastNotifier } from '../../src/shared/types'
import { PetStateMachineImpl } from '../../src/renderer/stateMachine'
import { AUTO_HIDE_MS } from '../../src/shared/constants'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMocks() {
  const animationRenderer: jest.Mocked<AnimationRenderer> = {
    play: jest.fn(),
    stop: jest.fn(),
    getCurrentAnimation: jest.fn().mockReturnValue(null),
  }

  const tooltipBubble: jest.Mocked<TooltipBubble> = {
    show: jest.fn(),
    hide: jest.fn(),
    update: jest.fn(),
    setAutoHide: jest.fn(),
  }

  const toastNotifier: jest.Mocked<ToastNotifier> = {
    configure: jest.fn(),
    notify: jest.fn(),
  }

  return { animationRenderer, tooltipBubble, toastNotifier }
}

function makeMachine() {
  const mocks = makeMocks()
  const machine = new PetStateMachineImpl(
    mocks.animationRenderer,
    mocks.tooltipBubble,
    mocks.toastNotifier,
  )
  return { machine, ...mocks }
}

// ---------------------------------------------------------------------------
// Requirement 4.1 — Initialization
// ---------------------------------------------------------------------------

describe('PetStateMachineImpl — initialization (Req 4.1)', () => {
  it('initializes to idle state', () => {
    const { machine } = makeMachine()
    expect(machine.getCurrentState()).toBe('idle')
  })
})

describe('PetStateMachineImpl dispatch acceptance result', () => {
  it('returns true for accepted transitions and false for rejected transitions', () => {
    const { machine } = makeMachine()

    expect(machine.dispatch('done', 'Cannot finish before work starts')).toBe(false)
    expect(machine.getCurrentState()).toBe('idle')
    expect(machine.dispatch('working', 'Starting')).toBe(true)
    expect(machine.getCurrentState()).toBe('working')
  })
})

// ---------------------------------------------------------------------------
// Requirement 4.2 — Valid transitions
// ---------------------------------------------------------------------------

describe('PetStateMachineImpl — valid transitions (Req 4.2)', () => {
  it('transitions idle → working', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', 'Starting task')
    expect(machine.getCurrentState()).toBe('working')
  })

  it('transitions idle → error', () => {
    const { machine } = makeMachine()
    machine.dispatch('error', 'Something went wrong')
    expect(machine.getCurrentState()).toBe('error')
  })

  it('transitions working → done', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('done', 'Task complete')
    expect(machine.getCurrentState()).toBe('done')
  })

  it('transitions working → waiting', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('waiting', 'Waiting for input')
    expect(machine.getCurrentState()).toBe('waiting')
  })

  it('transitions working → error', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('error', 'Build failed')
    expect(machine.getCurrentState()).toBe('error')
  })

  it('transitions waiting → working', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('waiting', '')
    machine.dispatch('working', 'Resuming')
    expect(machine.getCurrentState()).toBe('working')
  })

  it('transitions waiting → error', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('waiting', '')
    machine.dispatch('error', 'Timed out')
    expect(machine.getCurrentState()).toBe('error')
  })

  it('transitions done → idle', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('done', '')
    machine.dispatch('idle', '')
    expect(machine.getCurrentState()).toBe('idle')
  })

  it('transitions done → working when a new prompt starts', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('done', '')
    machine.dispatch('working', 'Starting another prompt')
    expect(machine.getCurrentState()).toBe('working')
  })

  it('transitions error → idle', () => {
    const { machine } = makeMachine()
    machine.dispatch('error', '')
    machine.dispatch('idle', '')
    expect(machine.getCurrentState()).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// Requirement 4.3 — Invalid transitions rejected
// ---------------------------------------------------------------------------

describe('PetStateMachineImpl — invalid transitions rejected (Req 4.3)', () => {
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('rejects idle → done and logs the correct message', () => {
    const { machine } = makeMachine()
    machine.dispatch('done', '')
    expect(machine.getCurrentState()).toBe('idle')
    expect(logSpy).toHaveBeenCalledWith('Invalid transition: idle → done')
  })

  it('rejects idle → waiting and logs the correct message', () => {
    const { machine } = makeMachine()
    machine.dispatch('waiting', '')
    expect(machine.getCurrentState()).toBe('idle')
    expect(logSpy).toHaveBeenCalledWith('Invalid transition: idle → waiting')
  })

  it('rejects working → idle and logs the correct message', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    logSpy.mockClear()
    machine.dispatch('idle', '')
    expect(machine.getCurrentState()).toBe('working')
    expect(logSpy).toHaveBeenCalledWith('Invalid transition: working → idle')
  })

  it('rejects done → error and logs the correct message', () => {
    const { machine } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('done', '')
    logSpy.mockClear()
    machine.dispatch('error', '')
    expect(machine.getCurrentState()).toBe('done')
    expect(logSpy).toHaveBeenCalledWith('Invalid transition: done → error')
  })

  it('rejects error → working and logs the correct message', () => {
    const { machine } = makeMachine()
    machine.dispatch('error', '')
    logSpy.mockClear()
    machine.dispatch('working', '')
    expect(machine.getCurrentState()).toBe('error')
    expect(logSpy).toHaveBeenCalledWith('Invalid transition: error → working')
  })

  it('does not update state on any invalid transition', () => {
    const { machine } = makeMachine()
    // idle → done is invalid
    machine.dispatch('done', 'should be ignored')
    expect(machine.getCurrentState()).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// Requirement 4.4 — Tooltip behavior
// ---------------------------------------------------------------------------

describe('PetStateMachineImpl — tooltip behavior (Req 4.4)', () => {
  it('calls tooltipBubble.show(message) when message is non-empty', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('working', 'Doing something')
    expect(tooltipBubble.show).toHaveBeenCalledWith('Doing something')
    expect(tooltipBubble.hide).not.toHaveBeenCalled()
  })

  it('calls tooltipBubble.hide() when message is empty string', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('working', '')
    expect(tooltipBubble.hide).toHaveBeenCalledTimes(1)
    expect(tooltipBubble.show).not.toHaveBeenCalled()
  })

  it('calls tooltipBubble.setAutoHide(4000) for done transition with non-empty message', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('done', 'All done!')
    expect(tooltipBubble.setAutoHide).toHaveBeenCalledWith(AUTO_HIDE_MS)
  })

  it('calls tooltipBubble.setAutoHide(4000) for error transition with non-empty message', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('error', 'Something broke')
    expect(tooltipBubble.setAutoHide).toHaveBeenCalledWith(AUTO_HIDE_MS)
  })

  it('does NOT call tooltipBubble.setAutoHide() for idle transition', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('error', '')
    tooltipBubble.setAutoHide.mockClear()
    machine.dispatch('idle', 'Back to idle')
    expect(tooltipBubble.setAutoHide).not.toHaveBeenCalled()
  })

  it('does NOT call tooltipBubble.setAutoHide() for working transition', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('working', 'Working hard')
    expect(tooltipBubble.setAutoHide).not.toHaveBeenCalled()
  })

  it('does NOT call tooltipBubble.setAutoHide() for waiting transition', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('waiting', 'Waiting for you')
    expect(tooltipBubble.setAutoHide).not.toHaveBeenCalled()
  })

  it('does NOT call tooltipBubble.setAutoHide() when message is empty even for done', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('done', '')
    expect(tooltipBubble.setAutoHide).not.toHaveBeenCalled()
  })

  it('does NOT call tooltipBubble.setAutoHide() when message is empty even for error', () => {
    const { machine, tooltipBubble } = makeMachine()
    machine.dispatch('error', '')
    expect(tooltipBubble.setAutoHide).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Requirement 4.5 — Toast notifications
// ---------------------------------------------------------------------------

describe('PetStateMachineImpl — toast notifications (Req 4.5)', () => {
  it('fires toastNotifier.notify() when transitioning to done', () => {
    const { machine, toastNotifier } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('done', 'Task complete')
    expect(toastNotifier.notify).toHaveBeenCalledTimes(1)
  })

  it('fires toastNotifier.notify() when transitioning to error', () => {
    const { machine, toastNotifier } = makeMachine()
    machine.dispatch('error', 'Something went wrong')
    expect(toastNotifier.notify).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire toastNotifier.notify() when transitioning to idle', () => {
    const { machine, toastNotifier } = makeMachine()
    machine.dispatch('error', '')
    toastNotifier.notify.mockClear()
    machine.dispatch('idle', '')
    expect(toastNotifier.notify).not.toHaveBeenCalled()
  })

  it('does NOT fire toastNotifier.notify() when transitioning to working', () => {
    const { machine, toastNotifier } = makeMachine()
    machine.dispatch('working', 'Starting')
    expect(toastNotifier.notify).not.toHaveBeenCalled()
  })

  it('does NOT fire toastNotifier.notify() when transitioning to waiting', () => {
    const { machine, toastNotifier } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('waiting', 'Waiting')
    expect(toastNotifier.notify).not.toHaveBeenCalled()
  })

  it('passes the correct title and message to toastNotifier.notify() for done', () => {
    const { machine, toastNotifier } = makeMachine()
    machine.dispatch('working', '')
    machine.dispatch('done', 'All finished!')
    expect(toastNotifier.notify).toHaveBeenCalledWith('Kiro is done', 'All finished!')
  })

  it('passes the correct title and message to toastNotifier.notify() for error', () => {
    const { machine, toastNotifier } = makeMachine()
    machine.dispatch('error', 'Build failed')
    expect(toastNotifier.notify).toHaveBeenCalledWith('Kiro encountered an error', 'Build failed')
  })
})
