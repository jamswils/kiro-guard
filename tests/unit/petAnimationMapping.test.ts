/**
 * @jest-environment jsdom
 */

import type { AnimationKey, StatusPayload } from '../../src/shared/types'
import {
  animationKeyForPayload,
  formatStatusLabel,
  shouldLoopPayload,
} from '../../src/renderer/pet'

function payload(overrides: Partial<StatusPayload>): StatusPayload {
  return {
    status: 'idle',
    message: 'test',
    timestamp: 1700000000000,
    ...overrides,
  }
}

describe('renderer status payload animation mapping', () => {
  const cases: Array<[Partial<StatusPayload>, AnimationKey, string, boolean]> = [
    [{ status: 'idle' }, 'idle', 'Kiro Ready', true],
    [{ status: 'working' }, 'working', 'Kiro Working', true],
    [{ status: 'waiting' }, 'waiting', 'Kiro Waiting', true],
    [{ status: 'asking' }, 'asking', 'Kiro Asking', true],
    [{ status: 'done' }, 'done', 'Kiro Done', false],
    [{ status: 'error' }, 'error', 'Kiro Error', false],
    [{ status: 'working', phase: 'design' }, 'design-working', 'Design Working', true],
    [{ status: 'working', phase: 'requirements' }, 'requirements-working', 'Requirements Working', true],
    [{ status: 'working', phase: 'tasks' }, 'tasks-working', 'Task List Working', true],
    [{ status: 'done', phase: 'design' }, 'design-done', 'Design Done', false],
    [{ status: 'done', phase: 'requirements' }, 'requirements-done', 'Requirements Done', false],
    [{ status: 'done', phase: 'tasks' }, 'tasks-done', 'Task List Done', false],
    [{ status: 'asking', phase: 'design' }, 'asking', 'Design Asking', true],
    [{ status: 'waiting', phase: 'requirements' }, 'waiting', 'Requirements Waiting', true],
    [{ status: 'error', phase: 'tasks' }, 'error', 'Task List Error', false],
  ]

  it.each(cases)(
    'maps %j to animation %s, label %s, loop=%s',
    (partialPayload, expectedAnimation, expectedLabel, expectedLoop) => {
      const statusPayload = payload(partialPayload)

      expect(animationKeyForPayload(statusPayload)).toBe(expectedAnimation)
      expect(formatStatusLabel(statusPayload)).toBe(expectedLabel)
      expect(shouldLoopPayload(statusPayload)).toBe(expectedLoop)
    },
  )

})
