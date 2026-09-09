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
  kirocrew: KiroCrewFeedConfig
  /** Bumped by configStore.runConfigMigrations(); absent on pre-migration installs. */
  configVersion?: number
}

/** How the lock screen is opened. 'none' = a click unlocks (the lock screen says so). */
export type AuthMode = 'windows' | 'passphrase' | 'none'

/** PBKDF2-SHA256 verifier. Base64 salt + hash; never the secret itself. */
export interface SecretVerifier {
  salt: string
  hash: string
  iterations: number
}

export interface RecoveryVerifier extends SecretVerifier {
  question: string
}

export interface LockConfig {
  hotkey: string
  /** Derived for callers: authMode !== 'none'. Persisted for old configs; authMode is the source of truth. */
  requireAuth: boolean
  authMode: AuthMode
  passphrase?: SecretVerifier
  recovery?: RecoveryVerifier
  autoLockOnAgentStart: boolean
  showElapsedTime: boolean
  lockMessage: string
}

/**
 * Live "what is KiroCrew doing" feed shown on the lock screen. Source 'ssh' runs
 * kiro_pulse.py on the KiroCrew host; 'file' reads a local text/JSON file that
 * something else keeps fresh (e.g. Freeze Screen's Sync-KiroPulse.ps1).
 */
export interface KiroCrewFeedConfig {
  enabled: boolean
  source: 'ssh' | 'file'
  sshHost: string
  remoteScript: string
  statusFile: string
  intervalMs: number
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
