import type { AnimationKey, StatusPayload, ToastNotifier } from '../shared/types'
import type { MoveWindowPayload } from '../shared/ipc'
import { DRAG_THROTTLE_MS } from '../shared/constants'
import { createAnimationRenderer } from './animationRenderer'
import { createPetStateMachine } from './stateMachine'
import { createTooltipBubble } from './tooltipBubble'

const STATUS_LABELS: Record<StatusPayload['status'], string> = {
  idle:    'Kiro Ready',
  working: 'Kiro Working',
  waiting: 'Kiro Waiting',
  asking:  'Kiro Asking',
  done:    'Kiro Done',
  error:   'Kiro Error',
}

const PHASE_LABELS: Record<NonNullable<StatusPayload['phase']>, string> = {
  design:       'Design',
  requirements: 'Requirements',
  tasks:        'Task List',
}

export function formatStatusLabel(payload: StatusPayload): string {
  if (!payload.phase) return STATUS_LABELS[payload.status]
  const phase = PHASE_LABELS[payload.phase]
  if (payload.status === 'working')  return `${phase} Working`
  if (payload.status === 'done')     return `${phase} Done`
  if (payload.status === 'error')    return `${phase} Error`
  if (payload.status === 'waiting')  return `${phase} Waiting`
  if (payload.status === 'asking')   return `${phase} Asking`
  return phase
}

export function animationKeyForPayload(payload: StatusPayload): AnimationKey {
  if (payload.phase && (payload.status === 'working' || payload.status === 'done')) {
    return `${payload.phase}-${payload.status}`
  }
  return payload.status
}

export function shouldLoopPayload(payload: StatusPayload): boolean {
  return (
    payload.status === 'idle'    ||
    payload.status === 'working' ||
    payload.status === 'waiting' ||
    payload.status === 'asking'
  )
}

function idlePayload(): StatusPayload {
  return { status: 'idle', message: '', timestamp: Date.now() }
}

declare global {
  interface Window {
    kiroBuddy?: {
      onStatusUpdate(handler: (payload: StatusPayload) => void): () => void
      moveWindow(position: MoveWindowPayload): void
      lock(): void
      unlock(): void
      toggleLock(): void
      onLockState(handler: (state: string, lockedAt?: number) => void): () => void
      getLockState(): Promise<{ state: string; lockedAt?: number }>
    }
  }
}

class RendererToastNotifier implements ToastNotifier {
  configure(): void {}
  notify(): void {}
}

class DragHandler {
  private dragging = false
  private offsetX = 0
  private offsetY = 0
  private lastSentAt = 0

  constructor(private readonly element: HTMLElement) {}

  attach(): void {
    this.element.addEventListener('mousedown', this.handleMouseDown)
    window.addEventListener('mousemove', this.handleMouseMove)
    window.addEventListener('mouseup', this.handleMouseUp)
  }

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    this.dragging = true
    this.offsetX = event.clientX
    this.offsetY = event.clientY
    this.element.classList.add('is-dragging')
  }

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.dragging) return
    const now = performance.now()
    if (now - this.lastSentAt < DRAG_THROTTLE_MS) return
    this.lastSentAt = now
    this.sendPosition(event)
  }

  private readonly handleMouseUp = (event: MouseEvent): void => {
    if (!this.dragging) return
    this.dragging = false
    this.element.classList.remove('is-dragging')
    this.sendPosition(event)
  }

  private sendPosition(event: MouseEvent): void {
    const nextX = window.screenX + event.clientX - this.offsetX
    const nextY = window.screenY + event.clientY - this.offsetY
    window.kiroBuddy?.moveWindow({ x: nextX, y: nextY })
  }
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing required element: ${id}`)
  return element
}

window.addEventListener('DOMContentLoaded', () => {
  const pet          = requiredElement('pet')
  const animation    = requiredElement('animation')
  const tooltip      = requiredElement('tooltip')
  const statusLabel  = requiredElement('status-label')
  const lockBadge    = requiredElement('lock-badge')

  const animationRenderer = createAnimationRenderer(animation)
  const tooltipBubble     = createTooltipBubble(tooltip)
  const stateMachine      = createPetStateMachine(
    animationRenderer,
    tooltipBubble,
    new RendererToastNotifier(),
  )

  animationRenderer.play({ key: 'idle', loop: true, speed: 1 })
  new DragHandler(pet).attach()
  pet.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  // ----- Lock badge -----
  lockBadge.hidden = false

  // Initialise lock badge state from main
  window.kiroBuddy?.getLockState().then((result) => {
    applyLockState(result.state)
  }).catch(() => {})

  // Listen for lock state changes
  window.kiroBuddy?.onLockState((state) => {
    applyLockState(state)
  })

  lockBadge.addEventListener('click', (e) => {
    e.stopPropagation()
    window.kiroBuddy?.toggleLock()
  })

  function applyLockState(state: string): void {
    pet.dataset.lock = state
    if (state === 'locked' || state === 'locking') {
      lockBadge.textContent = '🔒'
      lockBadge.classList.add('is-locked')
      lockBadge.title = 'Locked — click to unlock'
    } else {
      lockBadge.textContent = '🔓'
      lockBadge.classList.remove('is-locked')
      lockBadge.title = 'Unlocked — click to lock'
    }
  }

  // ----- Status -----
  let statusVersion = 0

  function applyPayload(payload: StatusPayload): void {
    const label = formatStatusLabel(payload)
    pet.dataset.status = payload.status
    if (payload.phase) pet.dataset.phase = payload.phase
    else delete pet.dataset.phase
    statusLabel.textContent = label
    pet.setAttribute('aria-label', label)
  }

  window.kiroBuddy?.onStatusUpdate((payload) => {
    statusVersion += 1
    const version = statusVersion
    const accepted = stateMachine.dispatch(payload.status, payload.message)
    if (!accepted) return

    applyPayload(payload)
    animationRenderer.play({
      key:   animationKeyForPayload(payload),
      loop:  shouldLoopPayload(payload),
      speed: 1,
      onComplete:
        payload.status === 'done'
          ? () => {
              if (statusVersion !== version) return
              const nextPayload = idlePayload()
              if (stateMachine.dispatch(nextPayload.status, nextPayload.message)) {
                applyPayload(nextPayload)
              }
            }
          : undefined,
    })
  })
})
