/**
 * Shared TypeScript types for Kiro Guard
 * Used by both main and renderer processes
 */

// ---------------------------------------------------------------------------
// Core status / state types
// ---------------------------------------------------------------------------

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'asking' | 'done' | 'error'
export type PetState = 'idle' | 'working' | 'waiting' | 'asking' | 'done' | 'error'
export type SpecPhase = 'design' | 'requirements' | 'tasks'
export type LockState = 'unlocked' | 'locking' | 'locked' | 'unlocking'

export type AnimationKey =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'asking'
  | 'done'
  | 'error'
  | 'design-working'
  | 'requirements-working'
  | 'tasks-working'
  | 'design-done'
  | 'requirements-done'
  | 'tasks-done'

// ---------------------------------------------------------------------------
// Payload / data interfaces
// ---------------------------------------------------------------------------

export interface StatusPayload {
  status: AgentStatus
  message: string
  timestamp: number
  phase?: SpecPhase
  context?: string
}

export interface LockStatusPayload {
  state: LockState
  lockedAt?: number
  message?: string
}

// ---------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------

export interface AppConfig {
  window: {
    x: number
    y: number
    width: number
    height: number
  }
  statusFilePath: string
  notifications: NotificationConfig
  clickThrough: boolean
  pollIntervalMs: number
  petScale: number
  lock: LockConfig
  /** Bumped by configStore.runConfigMigrations(); absent on pre-migration installs. */
  configVersion?: number
}

export interface LockConfig {
  hotkey: string
  requireAuth: boolean
  autoLockOnAgentStart: boolean
  showElapsedTime: boolean
  lockMessage: string
}

export interface OverlayWindowConfig {
  width: number
  height: number
  x: number
  y: number
  alwaysOnTop: boolean
  transparent: boolean
  frame: boolean
  skipTaskbar: boolean
}

export interface AnimationConfig {
  key: AnimationKey
  loop: boolean
  speed: number
  onComplete?: () => void
}

export interface NotificationConfig {
  enabled: boolean
  onDone: boolean
  onError: boolean
}

export interface StateTransition {
  from: PetState | '*'
  to: PetState
  action: () => void
}

export interface AnimationRenderer {
  play(config: AnimationConfig): void
  stop(): void
  getCurrentAnimation(): AnimationKey | null
}

export interface TooltipBubble {
  show(message: string): void
  hide(): void
  update(message: string): void
  setAutoHide(durationMs: number): void
}

export interface ToastNotifier {
  configure(config: NotificationConfig): void
  notify(title: string, body: string): void
}

export interface PetStateMachine {
  dispatch(newState: PetState, message: string): boolean
  getCurrentState(): PetState
  onTransition(callback: (from: PetState, to: PetState) => void): void
}
